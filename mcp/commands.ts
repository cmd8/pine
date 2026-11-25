// Bundled MCP server "commands": turns fixed shell commands into typed tools.
//
// An agent that should be able to "check the printer" does not need a shell for it. Declare the
// command once; the model only fills in the parameters you defined. Arguments are passed as an
// argument vector, never through a shell, so a parameter cannot smuggle in a second command.
//
// options: {
//   commands: {
//     <tool name>: {
//       description,
//       run: ["program", "arg", "{{param}}", ...],
//       params?: { <name>: { type?: "string"|"number"|"boolean", description?, enum?, pattern?, required?, default? } },
//       timeoutSec?, cwd?, env?, sandbox?, maxOutput?
//     }
//   },
//   cwd, sandbox, env               // filled in by pine: the agent's workspace, what puts a command into its sandbox, its shell environment
// }
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { type McpTool, options, serve } from "./lib.ts";

interface Param {
	type?: "string" | "number" | "boolean";
	description?: string;
	enum?: unknown[];
	pattern?: string;
	required?: boolean;
	default?: unknown;
}
interface Command {
	description: string;
	run: string[];
	params?: Record<string, Param>;
	timeoutSec?: number;
	cwd?: string;
	env?: Record<string, string>;
	sandbox?: boolean;
	maxOutput?: number;
}

const o = options<{ commands?: Record<string, Command>; cwd?: string; sandbox?: string[]; env?: Record<string, string> }>();

export function buildArgv(cmd: Command, args: Record<string, unknown>): string[] {
	const values: Record<string, string> = {};
	for (const [name, p] of Object.entries(cmd.params ?? {})) {
		const v = args[name] ?? p.default;
		if (v === undefined || v === null || v === "") {
			if (p.required !== false && p.default === undefined) throw new Error(`parameter "${name}" is required`);
			values[name] = "";
			continue;
		}
		const s = String(v);
		if (p.type === "number" && !Number.isFinite(Number(v))) throw new Error(`parameter "${name}" must be a number`);
		if (p.type === "boolean" && !["true", "false"].includes(s)) throw new Error(`parameter "${name}" must be true or false`);
		if (p.enum && !p.enum.map(String).includes(s)) throw new Error(`parameter "${name}" must be one of: ${p.enum.join(", ")}`);
		if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(s)) throw new Error(`parameter "${name}" has an invalid format`);
		// A value that starts with "-" would be read as an option by most programs.
		if (s.startsWith("-") && p.type !== "number" && !p.pattern && !p.enum) throw new Error(`parameter "${name}" must not start with "-"`);
		if (s.includes("\0")) throw new Error(`parameter "${name}" contains an invalid character`);
		values[name] = s;
	}
	return cmd.run.map((part) => part.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name) => (name in values ? values[name] : "")));
}

/** Commands still running, each ended with its group when the session that called them closes. */
const running = new Set<() => void>();

export function run(name: string, cmd: Command, args: Record<string, unknown>): Promise<string> {
	let argv = buildArgv(cmd, args);
	if (cmd.sandbox && o.sandbox?.length) argv = [...o.sandbox, ...argv];
	const max = cmd.maxOutput ?? 30_000;
	const limit = cmd.timeoutSec ?? 30;
	return new Promise((resolve, reject) => {
		// A group of its own, so that a command which starts more (`bash -lc "thing & sleep 999"`) can be ended whole:
		// the others inherit its stdout and stderr, and a command killed on its own leaves them holding the pipes, so
		// the answer would be waited for as long as they run.
		const child = spawn(argv[0], argv.slice(1), { cwd: cmd.cwd ?? o.cwd, env: { ...(o.env ?? { PATH: process.env.PATH ?? "" }), ...(cmd.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
		let out = "";
		let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let stopped = false;
		let settled = false;
		const add = (d: Buffer) => {
			if (out.length < max) out += d.toString("utf8");
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		// The whole group. Windows has none: a program's tree is ended by its parents instead (taskkill /T).
		const group = () => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
				return;
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// nobody left in it
			}
		};
		running.add(group);
		const settle = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			running.delete(group);
			clearTimeout(timer);
			// Whatever still writes to them is not this call's answer, and must not hold the call open.
			child.stdout.destroy();
			child.stderr.destroy();
			const text = out.length > max ? `${out.slice(0, max)}\n[output cut at ${max} characters]` : out;
			// The timeout is named as one even where a killed program answers with an exit code and no signal (Windows).
			if (stopped || signal) return reject(new Error(`${name} was stopped after ${limit} s\n${text}`));
			if (code !== 0) return reject(new Error(`${name} exited with code ${code}\n${text}`));
			resolve(text.trim() || "(no output)");
		};
		const timer = setTimeout(() => {
			stopped = true;
			group();
			// One that had already ended is answered from its exit, which has come.
			if (ended) settle(ended.code, ended.signal);
		}, limit * 1000);
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			running.delete(group);
			clearTimeout(timer);
			reject(new Error(`${name}: ${e.message}`));
		});
		child.on("exit", (code, signal) => {
			ended = { code, signal };
			// Answered from here, not from `close`, when the timeout is what ended it: a program that left the group
			// (job control gives each job one of its own) is not reached by the kill and keeps the pipes open, and
			// `close` would wait for it. Any other ending is answered from `close`, so that the last of what the
			// command wrote is in the answer.
			if (stopped) settle(code, signal);
		});
		child.on("close", settle);
	});
}

if (import.meta.main) {
	// A command is in a group of its own, out of reach of the kill of this server's group with which pi closes a
	// session (stdin closed, then SIGTERM): end every one that still runs when that comes.
	const endAll = () => {
		for (const end of running) end();
		process.exit(0);
	};
	process.stdin.on("end", endAll);
	process.on("SIGTERM", endAll);
	const tools: McpTool[] = Object.entries(o.commands ?? {}).map(([name, cmd]) => ({
		name,
		description: cmd.description,
		inputSchema: {
			type: "object",
			properties: Object.fromEntries(Object.entries(cmd.params ?? {}).map(([p, d]) => [p, { type: d.type ?? "string", ...(d.description ? { description: d.description } : {}), ...(d.enum ? { enum: d.enum } : {}) }])),
			required: Object.entries(cmd.params ?? {}).filter(([, d]) => d.required !== false && d.default === undefined).map(([p]) => p),
		},
		handler: (args) => run(name, cmd, args),
	}));
	serve({ name: "pine-commands", version: "0.1.0" }, tools);
}
