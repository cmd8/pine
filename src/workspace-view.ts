import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bin, helperArgv, helperBase, helperPath, isInside, realish } from "./security.ts";

// What a UI shows beside a conversation: the files of the folder it works in, and what changed
// there according to git. Everything here only reads. None of it reaches a model.

export interface Change {
	/** Path from the top of the repository. */
	path: string;
	/** "M" changed, "A" added, "D" deleted, "R" renamed, "?" not tracked yet. */
	status: string;
	added?: number;
	removed?: number;
}

const MAX_OUT = 2_000_000;

/**
 * Run git so that it can only look. A repository's own configuration can name programs for git
 * to run (filters, diff drivers, hooks, a file system monitor); a folder somebody cloned must not
 * get to run anything with the daemon's rights just because it was looked at. So git runs in a
 * sandbox that can neither write nor use the network, and with the programs it would start for
 * a diff turned off. Every git call of the daemon goes through here.
 */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<{ code: number; out: string; raw: Buffer; err: string }> {
	const none = { out: "", raw: Buffer.alloc(0) };
	const jail = helperArgv(opts.write);
	if (!jail) return Promise.resolve({ code: 127, ...none, err: "there is no sandbox on this system to run git in" });
	const safe = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "safe.directory=*", "-c", "color.ui=false", "-c", "core.quotePath=false"];
	const max = opts.maxBytes ?? MAX_OUT;
	return new Promise((resolve) => {
		const child = spawn(jail[0], [...jail.slice(1), bin("git"), "-C", cwd, ...safe, ...args], { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...helperBase(), PATH: helperPath(), HOME: process.env.HOME ?? os.homedir(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env } });
		const chunks: Buffer[] = [];
		let size = 0;
		let err = "";
		child.stdout!.on("data", (d: Buffer) => {
			size += d.length;
			if (size <= max) chunks.push(d);
			else child.kill("SIGKILL");
		});
		child.stderr!.on("data", (d: Buffer) => (err.length < 2000 ? (err += d.toString("utf8")) : undefined));
		if (opts.stdin !== undefined) {
			child.stdin!.on("error", () => {});
			child.stdin!.end(opts.stdin);
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 15_000);
		child.on("error", (e) => (clearTimeout(timer), resolve({ code: 127, ...none, err: e.message })));
		child.on("close", (code) => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks);
			resolve({ code: code ?? 1, out: raw.toString("utf8"), raw, err });
		});
	});
}

/**
 * What a git call may do beyond looking. The snapshots behind undo (`src/snapshots.ts`) are the
 * one user: they write into a git directory of pine's own and, for a restore the owner asked
 * for, into the folder itself. `write` is enforced by the sandbox, not by git.
 */
export interface GitOptions {
	/** Folders git may write in. Without any it can only look. */
	write?: string[];
	stdin?: Buffer | string;
	/** More environment: a git directory, an index file of its own. */
	env?: Record<string, string>;
	maxBytes?: number;
	timeoutMs?: number;
}

/** The repository a folder lies in, if any: its top folder and the branch that is checked out. */
async function repository(root: string): Promise<{ top: string; branch: string } | undefined> {
	const top = await git(root, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.out.trim()) return undefined;
	const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return { top: realish(top.out.trim()), branch: branch.code === 0 ? branch.out.trim() : "" };
}

/** What differs from the last commit in a folder: changed, added, deleted and new files, with line counts. */
export async function changes(root: string): Promise<{ repo: boolean; branch?: string; top?: string; files: Change[]; more: boolean }> {
	const repo = await repository(root);
	if (!repo) return { repo: false, files: [], more: false };
	const status = await git(repo.top, ["status", "--porcelain=v1", "-z", "--", root]);
	const files: Change[] = [];
	const parts = status.out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		const file = entry.slice(3);
		// A rename is followed by the name it had before.
		if (xy.includes("R") || xy.includes("C")) i++;
		const code = xy === "??" ? "?" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : xy.includes("R") ? "R" : "M";
		files.push({ path: file, status: code });
	}
	const hasHead = (await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
	const counts = await git(repo.top, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", ...(hasHead ? ["HEAD"] : []), "--", root]);
	for (const line of counts.out.split("\0")) {
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		const file = m && files.find((f) => f.path === m[3]);
		if (m && file && m[1] !== "-") Object.assign(file, { added: Number(m[1]), removed: Number(m[2]) });
	}
	// A new file has no counts from git; its lines are all new.
	for (const f of files) {
		if (f.status !== "?" || f.path.endsWith("/")) continue;
		try {
			const full = path.join(repo.top, f.path);
			if (fs.statSync(full).size < 1_000_000) f.added = fs.readFileSync(full, "utf8").split("\n").length - 1;
		} catch {
			// gone since
		}
	}
	return { repo: true, branch: repo.branch, top: repo.top, files: files.slice(0, 300), more: files.length > 300 };
}

/** The diff of one file against the last commit. A file git does not know yet is shown as all new. */
export async function diffOf(root: string, file: string): Promise<{ diff: string; truncated: boolean } | undefined> {
	const repo = await repository(root);
	if (!repo || file.includes("\0")) return undefined;
	const target = realish(path.join(repo.top, file));
	if (!isInside(realish(root), target) && target !== realish(root)) return undefined;
	const hasHead = (await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
	let r = await git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", ...(hasHead ? ["HEAD"] : []), "--", file]);
	if (!r.out.trim()) r = await git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", file]);
	const max = 200_000;
	return { diff: r.out.slice(0, max), truncated: r.out.length > max };
}

/** A path inside a folder, with links resolved, or undefined when it leads out of it. */
function inside(root: string, rel: string): string | undefined {
	if (rel.includes("\0")) return undefined;
	const base = realish(root);
	const target = realish(path.join(base, rel));
	return target === base || isInside(base, target) ? target : undefined;
}

/**
 * Files of a folder whose path fits what somebody typed, the best first: for pointing an agent at
 * a file by a few letters of its name. In a repository these are the files git knows or would add
 * (ignored ones are left out); elsewhere a walk of bounded size that skips hidden folders and
 * `node_modules`. Nothing outside the folder is named.
 */
export async function findFiles(root: string, query: string, limit = 20): Promise<string[]> {
	const base = realish(root);
	let files: string[] = [];
	const listed = (await repository(base)) ? await git(base, ["ls-files", "-co", "--exclude-standard", "-z"]) : undefined;
	if (listed?.code === 0) files = listed.out.split("\0").filter(Boolean);
	else {
		const walk = (rel: string, depth: number) => {
			if (files.length >= 5000 || depth > 6) return;
			for (const e of listDir(base, rel)?.entries ?? []) {
				const next = rel ? `${rel}/${e.name}` : e.name;
				if (!e.dir) files.push(next);
				else if (!e.name.startsWith(".") && e.name !== "node_modules") walk(next, depth + 1);
			}
		};
		walk("", 0);
	}
	const q = query.toLowerCase();
	if (!q) return files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, limit);
	// Letters in order, with anything between them: "agts" finds "src/agents.ts".
	const inOrder = (text: string) => {
		let i = 0;
		for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
		return false;
	};
	const rank = (file: string) => {
		const lower = file.toLowerCase();
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : lower.includes(q) ? 3 : inOrder(name) ? 4 : inOrder(lower) ? 5 : -1;
	};
	return files
		.map((file) => ({ file, rank: rank(file) }))
		.filter((x) => x.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file))
		.slice(0, limit)
		.map((x) => x.file);
}

/** A file whose text holds what somebody looked for, with the first line that does. */
export interface Found {
	path: string;
	line: number;
	text: string;
}

/**
 * Files of a folder whose text holds what somebody typed, ignoring case, each with its first line
 * that does: for finding a file by what is in it. git's grep, which looks only (`git`): in a
 * repository the files it knows or would add, elsewhere every file but what a .gitignore leaves
 * out, and never `node_modules`. Binary files are skipped. Nothing outside the folder is named.
 */
export async function grepFiles(root: string, query: string, limit = 100): Promise<Found[]> {
	if (!query || query.includes("\0")) return [];
	const base = realish(root);
	const where = (await repository(base)) ? ["--untracked"] : ["--no-index", "--exclude-standard"];
	const r = await git(base, ["grep", ...where, "-I", "-i", "-F", "-n", "-z", "--max-count=1", "-e", query, "--", ".", ":(exclude,glob)**/node_modules/**"], { maxBytes: 1_000_000, timeoutMs: 10_000 });
	const found: Found[] = [];
	for (const row of r.out.split("\n")) {
		const [file, line, ...rest] = row.split("\0");
		if (!file || !line) continue;
		const text = rest.join("\0");
		// A long line is cut around what was found.
		const at = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()) - 40);
		found.push({ path: file, line: Number(line), text: (at ? "…" : "") + text.slice(at, at + 200).trim() });
		if (found.length >= limit) break;
	}
	return found;
}

export interface Entry {
	name: string;
	dir: boolean;
	size: number;
}

/** What is in one folder: folders first, then files, by name. Git's own folder is left out. */
export function listDir(root: string, rel: string): { entries: Entry[]; more: boolean } | undefined {
	const dir = inside(root, rel);
	if (!dir) return undefined;
	let names: fs.Dirent[];
	try {
		names = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const entries: Entry[] = [];
	for (const d of names) {
		if (d.name === ".git" || d.name === ".DS_Store") continue;
		const full = path.join(dir, d.name);
		try {
			const stat = fs.statSync(full);
			// A link that leads out of the folder is not shown as part of it.
			if (!inside(root, path.relative(realish(root), full))) continue;
			entries.push({ name: d.name, dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size });
		} catch {
			// a broken link
		}
	}
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
	return { entries: entries.slice(0, 500), more: entries.length > 500 };
}

/** A file's text, for reading. Binary files and very large ones are only described. */
/** The most text one read or one write of a file carries: what an editor in a UI works on. */
export const MAX_EDIT = 2 * 1024 * 1024;

export function readText(root: string, rel: string, max = 256 * 1024): { text?: string; size: number; binary: boolean; truncated: boolean } | undefined {
	const file = inside(root, rel);
	if (!file) return undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return undefined;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(Math.min(stat.size, max));
		fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		if (buf.subarray(0, 8192).includes(0)) return { size: stat.size, binary: true, truncated: false };
		return { text: buf.toString("utf8"), size: stat.size, binary: false, truncated: stat.size > max };
	} catch {
		return undefined;
	}
}

/**
 * Write a file's text: what the owner changed in an editor of a UI. The one place here that
 * does not only read, and the owner's alone (the control API; no tool reaches it).
 *
 * The folder is one an agent writes in, so nothing in it is taken at its word: a file of that
 * name may be a link to somewhere else or a second name of a file that lies elsewhere too, and a
 * folder on the way may become a link between a look and the write. The path is looked at
 * first, for a clear refusal. What keeps the write inside is not that look but `putInto`.
 * A missing file is made; a missing folder is not.
 */
export async function writeText(root: string, rel: string, text: string): Promise<{ size: number }> {
	if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Error("path: the file to write, from the top of the folder");
	if (typeof text !== "string") throw new Error("text: what the file is to hold");
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > MAX_EDIT) throw new Error(`that is too much for one file here (${bytes.length} bytes, at most ${MAX_EDIT})`);
	const base = realish(root);
	const named = path.resolve(base, rel);
	if (!isInside(base, named)) throw new Error(`${rel} is not a file in ${base}`);
	const dir = realish(path.dirname(named));
	if (dir !== base && !isInside(base, dir)) throw new Error(`${rel} leads out of ${base}: a link on the way points elsewhere`);
	let parent: fs.Stats | undefined;
	try {
		parent = fs.statSync(dir);
	} catch {
		// said below
	}
	if (!parent?.isDirectory()) throw new Error(`there is no folder ${path.dirname(rel)} in ${base}; a file is written into a folder that exists`);
	// Where a link of that name leads, if it is one: a link that stays in the folder is edited where its file lies.
	const target = realish(path.join(dir, path.basename(named)));
	if (!isInside(base, target)) throw new Error(`${rel} is a link that leads out of ${base}; the file it points at is not written from here`);
	// A file keeps its rights (a script stays one); a new one gets the usual ones.
	let mode = 0o644;
	try {
		const there = fs.statSync(target);
		if (there.isDirectory()) throw new Error(`${rel} is a folder`);
		if (there.isFile()) mode = there.mode & 0o777;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const done = await putInto(base, target, bytes, mode);
	if (done.code !== 0) throw new Error(`${rel} could not be written: ${done.err.trim().split("\n")[0] || `the helper ended with ${done.code}`}`);
	return { size: bytes.length };
}

/**
 * Put bytes into place as the file `target`, by a helper that the system's sandbox lets write
 * in `base` and nowhere else, as a restore of the snapshots relies on: whatever a path has
 * become since it was looked at, nothing outside the folder is written. The bytes go into a new
 * file beside the target, which is then moved over it. So the file that was there is never
 * written through, and what else it was (a link, another name of a file elsewhere) is left as
 * it is, with what it pointed at.
 */
export function putInto(base: string, target: string, bytes: Buffer, mode = 0o644): Promise<{ code: number; err: string }> {
	// A name nobody can have put there before; and should one be there, it is not written into (-C).
	const fresh = `${target}.pine-${crypto.randomBytes(9).toString("hex")}`;
	const script = 'set -eC; trap \'rm -f "$2"\' EXIT; cat > "$2"; chmod "$3" "$2"; mv -f "$2" "$1"';
	return inFolder(base, script, [target, fresh, (mode & 0o777).toString(8)], bytes);
}

/**
 * Run a fixed script of the shell's in a sandbox that lets it write in `base` and nowhere else: how
 * everything that changes a folder for the owner's hand is done (`putInto`, `changeFiles`). The
 * paths are arguments of their own, never part of the command's text.
 */
function inFolder(base: string, script: string, args: string[], stdin?: Buffer): Promise<{ code: number; err: string }> {
	const jail = helperArgv([base]);
	if (!jail) return Promise.resolve({ code: 127, err: "there is no sandbox on this system to change the folder in, and without one pine changes nothing in a folder an agent works in. Do it with a program of your own" });
	return new Promise((resolve) => {
		const child = spawn(jail[0], [...jail.slice(1), bin("sh"), "-c", script, "sh", ...args], { stdio: [stdin ? "pipe" : "ignore", "ignore", "pipe"], env: { ...helperBase(), PATH: helperPath(), LC_ALL: "C" } });
		let err = "";
		child.stderr!.on("data", (d: Buffer) => (err.length < 2000 ? (err += d.toString("utf8")) : undefined));
		if (stdin) {
			child.stdin!.on("error", () => {});
			child.stdin!.end(stdin);
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("error", (e) => (clearTimeout(timer), resolve({ code: 127, err: e.message })));
		child.on("close", (code) => (clearTimeout(timer), resolve({ code: code ?? 1, err })));
	});
}

/** What the owner does to the files of a conversation's folder from a UI's file tree, besides writing one. */
export type FileChange =
	| { op: "folder" | "file"; path: string }
	| { op: "rename"; path: string; to: string }
	| { op: "copy" | "move"; paths: string[]; into: string }
	| { op: "delete"; paths: string[] };

/**
 * A name in the folder, as it is to be acted on: the folder it lies in with links resolved (which
 * has to be inside), and the last part as it is, so that a link is moved, copied or deleted itself
 * and never what it points at. The root itself is no such name. As for `writeText`, this look is for
 * a clear refusal; what keeps every change inside is the sandbox of `inFolder`.
 */
function nameIn(base: string, rel: unknown, what: string): string {
	if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Error(`${what}: a path from the top of the folder`);
	const named = path.resolve(base, rel);
	if (named === base || !isInside(base, named)) throw new Error(`${rel} is not a name in ${base}`);
	const dir = realish(path.dirname(named));
	if (dir !== base && !isInside(base, dir)) throw new Error(`${rel} leads out of ${base}: a link on the way points elsewhere`);
	return path.join(dir, path.basename(named));
}

const exists = (p: string) => {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
};

/** "name copy.ext", then "name copy 2.ext" and on: a name for a copy that nothing in `dir` has. */
function freeName(dir: string, name: string): string {
	if (!exists(path.join(dir, name))) return name;
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let n = 1; ; n++) {
		const next = `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
		if (!exists(path.join(dir, next))) return next;
	}
}

const TAKEN = 17;
// Each script refuses to put anything where something already is (TAKEN), and makes the folders a new name needs.
const SCRIPTS = {
	folder: `if [ -e "$1" ] || [ -L "$1" ]; then exit ${TAKEN}; fi; mkdir -p -- "$1"`,
	file: `set -e; if [ -e "$1" ] || [ -L "$1" ]; then exit ${TAKEN}; fi; mkdir -p -- "$(dirname -- "$1")"; set -C; : > "$1"`,
	// A third argument says that only the case of the name changes, which a system that ignores case calls taken.
	rename: `set -e; if [ -z "$3" ] && { [ -e "$2" ] || [ -L "$2" ]; }; then exit ${TAKEN}; fi; mkdir -p -- "$(dirname -- "$2")"; mv -- "$1" "$2"`,
	// -P: a link is copied as the link it is, never followed.
	copy: `set -e; while [ $# -gt 1 ]; do if [ -e "$2" ] || [ -L "$2" ]; then exit ${TAKEN}; fi; cp -RP -- "$1" "$2"; shift 2; done`,
	move: `set -e; while [ $# -gt 1 ]; do if [ -e "$2" ] || [ -L "$2" ]; then exit ${TAKEN}; fi; mv -- "$1" "$2"; shift 2; done`,
	// rm does not follow a link, to a folder or anywhere else.
	delete: `rm -rf -- "$@"`,
};

/**
 * Make, rename, copy, move or delete files of a conversation's folder: what the owner does in a UI's
 * file tree. The owner's alone (the control API; no tool reaches it), and done as `writeText` writes:
 * every name looked at for a clear refusal (`nameIn`), the change itself made by a fixed script in a
 * sandbox that writes in the folder and nowhere else (`inFolder`). Nothing is put where something
 * already is: a copy gets a free name, anything else is refused. Returns the names as they are now.
 *
 * `keep` names files at the top of the folder that stay where they are, whatever is asked: in an
 * agent's workspace its own files (`WORKSPACE_FILES`), which can be edited and copied but are not
 * deleted, moved or renamed. A deletion or a move of several names leaves those out and says so
 * (`kept`); a rename of one is refused.
 */
export async function changeFiles(root: string, change: FileChange, keep: string[] = []): Promise<{ paths: string[]; kept?: string[] }> {
	const base = realish(root);
	const own = (p: string) => path.dirname(p) === base && keep.some((k) => k.toLowerCase() === path.basename(p).toLowerCase());
	const rel = (p: string) => path.relative(base, p).split(path.sep).join("/");
	const run = async (script: string, args: string[], what: string) => {
		const done = await inFolder(base, script, args);
		if (done.code === TAKEN) throw new Error(`there is already something named ${what}`);
		if (done.code !== 0) throw new Error(`${what}: ${done.err.trim().split("\n")[0] || `the helper ended with ${done.code}`}`);
	};
	const many = (paths: unknown) => {
		if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new Error("paths: the files and folders, from the top of the folder");
		return [...new Set(paths.map((p) => nameIn(base, p, "paths")))];
	};
	switch (change?.op) {
		case "folder":
		case "file": {
			const target = nameIn(base, change.path, "path");
			await run(SCRIPTS[change.op], [target], rel(target));
			return { paths: [rel(target)] };
		}
		case "rename": {
			const from = nameIn(base, change.path, "path");
			const to = nameIn(base, change.to, "to");
			if (!exists(from)) throw new Error(`there is no ${rel(from)}`);
			if (own(from)) throw new Error(`${rel(from)} is one of the agent's own files: it can be edited, not renamed`);
			if (to === from) return { paths: [rel(to)] };
			if (isInside(from, to)) throw new Error(`${rel(from)} cannot go inside itself`);
			await run(SCRIPTS.rename, [from, to, to.toLowerCase() === from.toLowerCase() ? "case" : ""], rel(to));
			return { paths: [rel(to)] };
		}
		case "copy":
		case "move": {
			const asked = many(change.paths);
			const kept = change.op === "move" ? asked.filter(own) : [];
			const sources = asked.filter((p) => !kept.includes(p));
			const into = change.into === "" ? base : nameIn(base, change.into, "into");
			let folder: fs.Stats | undefined;
			try {
				folder = fs.statSync(into);
			} catch {
				// said below
			}
			if (!folder?.isDirectory()) throw new Error(`${change.into || "the top"} is not a folder`);
			const dir = realish(into);
			if (dir !== base && !isInside(base, dir)) throw new Error(`${change.into} leads out of ${base}: it is a link to a folder elsewhere`);
			const pairs: string[] = [];
			const now: string[] = [];
			for (const from of sources) {
				if (!exists(from)) throw new Error(`there is no ${rel(from)}`);
				if (isInside(from, dir)) throw new Error(`${rel(from)} cannot go inside itself`);
				// Moved where it already is: nothing to do.
				if (change.op === "move" && path.dirname(from) === dir) {
					now.push(rel(from));
					continue;
				}
				const to = path.join(dir, change.op === "copy" ? freeName(dir, path.basename(from)) : path.basename(from));
				if (pairs.includes(to)) throw new Error(`two of these are named ${path.basename(from)}`);
				pairs.push(from, to);
				now.push(rel(to));
			}
			if (pairs.length) await run(SCRIPTS[change.op], pairs, change.op === "copy" ? "the copy" : now.join(", "));
			return kept.length ? { paths: now, kept: kept.map(rel) } : { paths: now };
		}
		case "delete": {
			const asked = many(change.paths);
			const kept = asked.filter(own);
			const targets = asked.filter((p) => !kept.includes(p));
			if (targets.length) await run(SCRIPTS.delete, targets, targets.map(rel).join(", "));
			return kept.length ? { paths: [], kept: kept.map(rel) } : { paths: [] };
		}
		default:
			throw new Error('op: "folder", "file", "rename", "copy", "move" or "delete"');
	}
}
