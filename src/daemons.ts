import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultHome } from "./config.ts";
import { expandHome } from "./util.ts";

// The pine daemons that run on this computer, found in the system's list of processes: `pine
// start`, `pine service` (the Pine app starts its pine that way) and the terminal UI with a daemon
// inside. For `pine list` and `pine killall`. Nothing is noted anywhere: what runs is what the
// system says runs, whichever version of pine started it.
//
// A process is pine's when it is Node running pine's command line (bin/pine.js, the link npm puts on
// the PATH, src/cli.ts or the compiled src/cli.js), never because "pine" appears somewhere in it.
// Whether a terminal UI holds a daemon or only talks to one is told by whether it listens on a
// port that answers pine's /health.

/** One process as the system lists it. */
export interface Proc {
	pid: number;
	ppid: number;
	/** Seconds it has been running. */
	age: number;
	argv: string[];
}

export interface Found {
	pid: number;
	/** What was run, as typed: "pine service --home ~/work". */
	command: string;
	how: "start" | "service" | "tui";
	/** The home it runs on: what --home named, else the default home. */
	home: string;
	/** Where its control API answers, if one answers. */
	base?: string;
	/** Whether the ports it listens on could be found at all. */
	portsKnown: boolean;
	age: number;
	/** Started by the Pine app. */
	app: boolean;
}

const run = (file: string, args: string[], timeout = 10_000) =>
	new Promise<string>((resolve) => {
		// lsof ends with 1 when it found nothing: what it wrote counts all the same.
		execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (_e, stdout) => resolve(stdout ?? ""));
	});

const firstThere = (...files: string[]) => files.find((f) => fs.existsSync(f));

/** "[[dd-]hh:]mm:ss", as ps says how long a process runs. */
const fromEtime = (t: string) => {
	const [days, rest] = t.includes("-") ? t.split("-") : ["0", t];
	return rest.split(":").map(Number).reduce((s, n) => s * 60 + n, 0) + Number(days) * 86_400;
};

/** A Windows command line as programs read it: spaces split, double quotes group, `\"` is a quote. */
export function windowsArgv(line: string): string[] {
	const argv: string[] = [];
	let cur = "";
	let quoted = false;
	let any = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "\\" && line[i + 1] === '"') {
			cur += '"';
			i++;
			any = true;
		} else if (c === '"') {
			quoted = !quoted;
			any = true;
		} else if (/\s/.test(c) && !quoted) {
			if (any) argv.push(cur);
			cur = "";
			any = false;
		} else {
			cur += c;
			any = true;
		}
	}
	if (any) argv.push(cur);
	return argv;
}

/**
 * A macOS command line back into its arguments. ps joins them with spaces and quotes nothing, so a
 * path with a space ("Application Support") is found by what pine's own command line looks like:
 * Node, its options, the script. What follows the script is split at spaces.
 */
export function macArgv(line: string): string[] {
	const m = /^(.*?(?:^|\/)node)((?:\s+-\S+)*)\s+(.*?(?:\/bin\/pine(?:\.js)?|\/src\/cli\.[jt]s))(?:\s+(.*))?$/.exec(line);
	if (!m) return line.split(/\s+/).filter(Boolean);
	return [m[1], ...m[2].split(/\s+/).filter(Boolean), m[3], ...(m[4] ?? "").split(/\s+/).filter(Boolean)];
}

async function processes(): Promise<Proc[]> {
	if (process.platform === "linux") {
		// /proc has every argument as it was given, and needs no program that a small system may lack.
		const tick = Number((await run(firstThere("/usr/bin/getconf", "/bin/getconf") ?? "getconf", ["CLK_TCK"])).trim()) || 100;
		const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
		const procs: Proc[] = [];
		const me = process.getuid!();
		for (const name of fs.readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			try {
				// Another user's pine is theirs to stop.
				if (fs.statSync(`/proc/${name}`).uid !== me) continue;
				const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
				const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				procs.push({ pid: Number(name), ppid: Number(fields[1]), age: Math.max(0, Math.round(uptime - Number(fields[19]) / tick)), argv });
			} catch {
				// gone meanwhile
			}
		}
		return procs;
	}
	if (process.platform === "win32") {
		const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const script = "$now = Get-Date; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; line = $_.CommandLine; age = if ($_.CreationDate) { [int]($now - $_.CreationDate).TotalSeconds } else { 0 } } })";
		const out = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", script], 30_000);
		try {
			const list = JSON.parse(out) as Array<{ pid: number; ppid: number; name: string; line: string | null; age: number }>;
			return list.map((p) => ({ pid: p.pid, ppid: p.ppid, age: p.age, argv: p.line ? windowsArgv(p.line) : [p.name] }));
		} catch {
			throw new Error("Windows did not list its processes (PowerShell's Get-CimInstance). Try again in a PowerShell window.");
		}
	}
	const out = await run(firstThere("/bin/ps", "/usr/bin/ps") ?? "ps", ["-xww", "-U", String(process.getuid!()), "-o", "pid=,ppid=,etime=,command="]);
	return out
		.split("\n")
		.map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), age: fromEtime(m[3]), argv: macArgv(m[4]) }));
}

/** The ports each of these processes listens on; undefined where the system cannot be asked. */
async function listening(pids: number[]): Promise<Map<number, number[]> | undefined> {
	const ports = new Map<number, number[]>();
	const add = (pid: number, port: number) => {
		if (!pids.includes(pid) || !port) return;
		const list = ports.get(pid) ?? [];
		if (!list.includes(port)) list.push(port);
		ports.set(pid, list);
	};
	if (!pids.length) return ports;
	if (process.platform === "linux") {
		// A socket that listens (state 0A) in /proc/net/tcp, by its inode, and the processes whose file descriptors are that socket.
		const inodes = new Map<string, number>();
		for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
			try {
				for (const row of fs.readFileSync(table, "utf8").split("\n").slice(1)) {
					const f = row.trim().split(/\s+/);
					if (f[3] === "0A") inodes.set(f[9], Number.parseInt(f[1].split(":").pop()!, 16));
				}
			} catch {
				// no IPv6
			}
		}
		for (const pid of pids) {
			try {
				for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
					const inode = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
					if (inode && inodes.has(inode)) add(pid, inodes.get(inode)!);
				}
			} catch {
				// gone, or not ours
			}
		}
		return ports;
	}
	if (process.platform === "win32") {
		const netstat = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "netstat.exe");
		const out = await run(netstat, ["-ano", "-p", "TCP"]);
		if (!out) return undefined;
		for (const row of out.split("\n")) {
			// "  TCP    127.0.0.1:7463    0.0.0.0:0    LISTENING    1234"; the state is in the system's language, so it is not read.
			const f = row.trim().split(/\s+/);
			if (f[0] === "TCP" && f.length === 5 && /:0$/.test(f[2])) add(Number(f[4]), Number(f[1].split(":").pop()));
		}
		return ports;
	}
	const lsof = firstThere("/usr/sbin/lsof", "/usr/bin/lsof");
	if (!lsof) return undefined;
	let pid = 0;
	for (const row of (await run(lsof, ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fpn"])).split("\n")) {
		if (row.startsWith("p")) pid = Number(row.slice(1));
		else if (row.startsWith("n")) add(pid, Number(row.split(":").pop()));
	}
	return ports;
}

/** The first of these ports on this computer that answers as pine's control API does. */
async function controlPort(ports: number[]): Promise<string | undefined> {
	const tries = await Promise.all(
		ports.map(async (port) => {
			const base = `http://127.0.0.1:${port}`;
			try {
				const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
				const body = (await res.json().catch(() => ({}))) as { ok?: unknown };
				return res.ok && body.ok === true ? base : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return tries.find(Boolean);
}

/**
 * What a process is to pine, from its arguments: undefined for anything that is not pine's command
 * line running a daemon or the terminal UI. `commands` are pine's command words, to tell
 * "pine <folder>" (the terminal UI) from "pine status".
 */
export function pineProcess(argv: string[], commands: Set<string>): { how: Found["how"]; home?: string; command: string } | undefined {
	if (!argv.length || !/^node(\.exe)?$/i.test(path.basename(argv[0].replaceAll("\\", "/")))) return undefined;
	let i = 1;
	// Node's own options come before the script.
	while (i < argv.length && argv[i].startsWith("-")) i++;
	const script = (argv[i] ?? "").replaceAll("\\", "/");
	if (!/(^|\/)bin\/pine(\.js)?$|(^|\/)src\/cli\.[jt]s$/i.test(script)) return undefined;
	const args = argv.slice(i + 1);
	let home: string | undefined;
	let word: string | undefined;
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (a === "--ssh" || a.startsWith("--ssh=")) return undefined; // the terminal UI of another machine's pine
		if (a === "--home") home = args[++j];
		else if (a.startsWith("--home=")) home = a.slice(7);
		else if (!a.startsWith("-") && word === undefined) word = a;
	}
	const how = word === "start" ? "start" : word === "service" ? "service" : word === undefined || word === "tui" || !commands.has(word) ? "tui" : undefined;
	if (!how) return undefined;
	return { how, home, command: ["pine", ...args].join(" ") };
}

/** The pine daemons that run on this computer, oldest first. This process is never among them. */
export async function findDaemons(commands: Set<string>): Promise<Found[]> {
	const all = await processes();
	const byPid = new Map(all.map((p) => [p.pid, p]));
	const candidates = all.flatMap((p) => {
		if (p.pid === process.pid) return [];
		const what = pineProcess(p.argv, commands);
		return what ? [{ p, what }] : [];
	});
	const ports = await listening(candidates.map((c) => c.p.pid));
	const found = await Promise.all(
		candidates.map(async ({ p, what }): Promise<Found | undefined> => {
			const base = ports ? await controlPort(ports.get(p.pid) ?? []) : undefined;
			// A terminal UI without a control API of its own talks to a daemon somewhere else. (`pine service` that
			// found a daemon ends at once; one that stays started one.)
			if (what.how === "tui" && ports && !base) return undefined;
			const parent = byPid.get(p.ppid)?.argv[0] ?? "";
			const app = /(^|[/\\])(Pine|pine-desktop)(\.exe)?$|Pine\.app\/|[/\\]Electron(\.exe)?$/.test(parent);
			const home = what.home ? path.resolve(expandHome(what.home)) : defaultHome();
			return { pid: p.pid, command: what.command, how: what.how, home, base, portsKnown: ports !== undefined, age: p.age, app };
		}),
	);
	return found.filter((f): f is Found => f !== undefined).sort((a, b) => b.age - a.age);
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: it runs, but is not this user's to signal.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * Stops them: SIGTERM, on which a daemon stops cleanly, and SIGKILL for one still there after
 * `graceMs`. (On Windows any signal ends a process at once: there is no asking it to stop.)
 */
export async function stopDaemons(daemons: Found[], graceMs = 12_000): Promise<Array<{ daemon: Found; how: "stopped" | "killed" | "failed"; error?: string }>> {
	const failed = new Map<number, string>();
	for (const d of daemons) {
		try {
			process.kill(d.pid, "SIGTERM");
		} catch (e) {
			if (alive(d.pid)) failed.set(d.pid, (e as Error).message);
		}
	}
	const deadline = Date.now() + graceMs;
	let waiting = daemons.map((d) => d.pid).filter((pid) => !failed.has(pid));
	while (waiting.length && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		waiting = waiting.filter(alive);
	}
	const killed = new Set<number>();
	for (const pid of waiting) {
		try {
			process.kill(pid, "SIGKILL");
			killed.add(pid);
		} catch (e) {
			if (alive(pid)) failed.set(pid, (e as Error).message);
		}
	}
	return daemons.map((daemon) => (failed.has(daemon.pid) ? { daemon, how: "failed" as const, error: failed.get(daemon.pid) } : { daemon, how: killed.has(daemon.pid) ? ("killed" as const) : ("stopped" as const) }));
}
