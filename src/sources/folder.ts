import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { isInside, realish } from "../security.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, parseDuration, resolvePath } from "../util.ts";

/**
 * A folder: reports every new or changed file once it has stopped growing. For things that drop
 * files: a scanner, a download folder, an export from another program.
 *
 * options: { dir, mask?, pattern?, ignore?, settle?, recursive? }
 *   dir        the folder to watch (~ and paths relative to the configuration file work)
 *   mask       only files whose name matches, as in a shell: "*.pdf", "*.{png,jpg}", "report-??.csv";
 *              several separated by commas
 *   pattern    only files whose full path matches this regular expression, e.g. "/src/.*\\.ts$"
 *   ignore     never files whose path matches this one. Default: version control, dependencies and
 *              editor leftovers (.git, node_modules, .DS_Store, files ending in ~ or .swp, and such)
 *   settle     how long a file must stay unchanged before it counts as complete (default "1.5s")
 *   recursive  also watch folders inside it (default true)
 *
 * event "added": { path, file, size, images? }   images is set for jpg, png, webp and gif under 10 MB
 */
/** How soon a watcher that failed is tried again, and how far apart the tries grow. Tests move it. */
export const timing = { retryMs: 1000, retryMaxMs: 60_000 };

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

/** A file name mask ("*.pdf", "*.{png,jpg}", "a?.txt, b*.md") as a test for a file's name. Capitals do not matter. */
export function maskTest(mask: string): RegExp {
	const one = (glob: string) =>
		glob
			.trim()
			.replace(/[.+^$()|[\]\\]/g, "\\$&")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/\{([^{}]*)\}/g, (_m, list: string) => `(?:${list.split(",").map((x) => x.trim()).join("|")})`);
	// Commas separate masks, except inside braces.
	const parts = mask.split(/,(?![^{]*\})/).map(one).filter(Boolean);
	return new RegExp(`^(?:${parts.join("|")})$`, "i");
}

export const type: SourceType = {
	summary: "a folder: reports every new or changed file in it. For a project folder, what a scanner saves, downloads, an export from another program",
	options: Type.Object(
		{
			dir: Type.String({ description: "the folder to watch, absolute or starting with ~" }),
			mask: Type.Optional(Type.String({ description: 'only files whose name matches, as in a shell: "*.pdf", "*.{png,jpg}"; several separated by commas' })),
			pattern: Type.Optional(Type.String({ description: 'only files whose full path matches this regular expression, for what a mask cannot say, e.g. "/src/.*\\.ts$"' })),
			ignore: Type.Optional(Type.String({ description: "never files whose path matches this regular expression. Default: version control, dependencies and editor leftovers (.git, node_modules, .DS_Store and such)" })),
			recursive: Type.Optional(Type.Boolean({ description: "also watch the folders inside it. Default true" })),
			settle: Type.Optional(Type.String({ description: 'how long a file must stay unchanged before it counts as complete. Default "1.5s"' })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		const dir = setup.resolve(o.dir);
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder that exists`);
		// Its own workspace is nothing new; a folder elsewhere is, and reading its files comes with watching it.
		const own = isInside(realish(setup.workspace), dir);
		// The workspace usually lies inside pine's home; everything else in there is pine's own.
		if (!own && (isInside(realish(setup.home), dir) || isInside(dir, realish(setup.home)))) throw new Error("pine's own folder cannot be watched");
		for (const key of ["pattern", "ignore"]) if (o[key]) new RegExp(o[key]);
		if (o.mask) maskTest(o.mask);
		if (o.settle) parseDuration(o.settle);
		const only = [o.mask ? `files named ${o.mask}` : "", o.pattern ? `paths matching ${o.pattern}` : ""].filter(Boolean).join(", ");
		return { options: { ...o, dir }, does: [`watch the folder ${dir}${only ? ` (${only})` : ""} for new and changed files`, ...(own ? [] : [`let ${setup.agent} read the files in that folder`])], opens: !own, read: own ? undefined : dir };
	},
};

export default function folder(source: SourceApi): void {
	const o = source.options;
	if (typeof o.dir !== "string" || !o.dir) throw new Error(`needs "dir": the folder to watch`);
	const dir = fs.realpathSync(resolvePath(o.dir, source.base));
	if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
	const pattern = o.pattern ? new RegExp(String(o.pattern), "i") : undefined;
	const mask = typeof o.mask === "string" && o.mask.trim() ? maskTest(o.mask) : undefined;
	// What changes all the time in a project folder without anyone having done anything worth a turn.
	const ignore = new RegExp(typeof o.ignore === "string" ? o.ignore : "(^|/)(\\.git|\\.hg|\\.svn|node_modules|\\.build|DerivedData|__pycache__|\\.venv|\\.DS_Store)(/|$)|(~|\\.swp|\\.tmp|\\.part|\\.crdownload)$", "i");
	const settleMs = parseDuration(o.settle ?? "1.5s");
	const pending = new Map<string, NodeJS.Timeout>();
	const seen = new Map<string, number>();
	// How many more looks a file that is there but empty gets before it is reported as it is: written
	// in one go a file is empty for an instant, while one made to be empty (a `touch`ed marker, a
	// lock) stays so, and waiting on it for ever kept a timer for it as long as pine ran and never
	// reported it at all.
	const EMPTY_ROUNDS = 2;
	source.media(dir);

	const check = (file: string, lastSize: number, round = 0) => {
		pending.delete(file);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
			// A link that leads out of the folder is not a file of this folder.
			if (!stat.isFile() || !fs.realpathSync(file).startsWith(dir + path.sep)) return;
		} catch {
			return;
		}
		if (stat.size !== lastSize || (stat.size === 0 && round < EMPTY_ROUNDS)) return void pending.set(file, setTimeout(() => check(file, stat.size, round + 1), settleMs));
		if (seen.get(file) === stat.mtimeMs) return;
		seen.set(file, stat.mtimeMs);
		if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, 2500)) seen.delete(k);
		const mimeType = TYPES[path.extname(file).toLowerCase()];
		source.emit("added", { path: file, file: path.relative(dir, file), size: stat.size, images: mimeType && stat.size < 10 * 1024 * 1024 ? [{ path: file, mimeType }] : undefined });
	};

	// A watcher gives up for reasons that are none of the folder's doing: an inotify limit reached, its
	// rights taken away, the folder removed or replaced (Windows says so with an error). Unhandled that
	// is an exception nothing catches, logged while the source still says it runs, so it goes into the
	// source's status, the dead watcher is dropped, and a new one is tried, further apart each time.
	// A new one throws at once while the folder is gone, and that is a failure like the other.
	let watcher: fs.FSWatcher | undefined;
	let retry: NodeJS.Timeout | undefined;
	let waitMs = timing.retryMs;
	let stopped = false;
	const failed = (e: unknown) => {
		if (stopped) return;
		watcher?.close();
		watcher = undefined;
		source.log.warn(`stopped watching ${dir}`, errText(e));
		// The status line is read without the outside-content mark, and an error's text can name a folder
		// inside, which anybody who drops files there named: only the error's code goes into it.
		const code = String((e as NodeJS.ErrnoException)?.code ?? "");
		source.status(`not watching the folder${/^E[A-Z]{2,12}$/.test(code) ? ` (${code})` : ""}; trying again in ${Math.round(waitMs / 1000)} s, and less often each time it fails`);
		retry = setTimeout(open, waitMs);
		waitMs = Math.min(waitMs * 2, timing.retryMaxMs);
	};
	const open = () => {
		retry = undefined;
		try {
			watcher = fs.watch(dir, { recursive: o.recursive !== false }, (_type, name) => {
				// One that reports something is a working one: the wait for a new one starts over.
				waitMs = timing.retryMs;
				if (!name) return;
				const file = path.join(dir, String(name));
				if ((pattern && !pattern.test(file)) || (mask && !mask.test(path.basename(file))) || ignore.test(String(name)) || pending.has(file)) return;
				pending.set(file, setTimeout(() => check(file, -1), 200));
			});
		} catch (e) {
			return failed(e);
		}
		watcher.on("error", failed);
		// A watcher that works has nothing to say about itself: this clears the line a failure wrote.
		source.status("");
		source.log.info(`watching ${dir}`);
	};
	open();
	source.onStop(() => {
		stopped = true;
		if (retry) clearTimeout(retry);
		watcher?.close();
		pending.forEach((t) => clearTimeout(t));
	});
}
