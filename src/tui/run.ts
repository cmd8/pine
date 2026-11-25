import { ProcessTerminal } from "@earendil-works/pi-tui";
import { loadConfig, type PineConfig } from "../config.ts";
import { findServer, listServers, piMcp, serverStates } from "../mcp-config.ts";
import { ensureDaemon } from "../service.ts";
import { errText } from "../util.ts";
import { PineTui, type TuiOptions } from "./app.ts";
import { Client } from "./client.ts";

type Opening = { folder?: string; worktree?: string | true };

/**
 * Open the terminal UI. It attaches to a running daemon; if none answers, it starts one inside
 * this process (logging to data/pine.log) and stops it again on exit.
 */
export async function runTui(cfg: PineConfig, opts: Opening = {}): Promise<void> {
	if (!cfg.http) throw new Error("the terminal UI needs the control API; remove \"http\": false from pine.json");
	needsTerminal();
	const service = await ensureDaemon(cfg);
	return open(new Client(service.base, service.token), service.mode, () => service.stop(), opts, {
		mcp: {
			// Read the files again each time: the daemon may have added a server since this UI started.
			list: async (states = true) => {
				const now = loadConfig(cfg.home);
				if (!states) return listServers(now).map((s) => ({ ...s, state: s.enabled ? undefined : "disabled" }));
				const found = await serverStates(now);
				return listServers(now).map((s) => ({ ...s, state: s.enabled ? (found[s.name] ?? (s.remote ? "unknown" : "local")) : "disabled" }));
			},
			login: async (name, onOutput) => {
				const now = loadConfig(cfg.home);
				const server = findServer(now, name);
				if (!server?.url) return onOutput(server ? `"${name}" is a local server and has no sign-in` : `no server "${name}"`), 1;
				return (await piMcp(now, { [name]: server }, ["login", name], { capture: true, onOutput })).code;
			},
		},
	});
}

/**
 * The terminal UI on the pine of another machine (`pine --ssh <host>`): one ssh connection runs
 * `pine service` there and forwards a port of this computer to that daemon (src/remote.ts, as
 * the Pine app does). Nothing of this computer's pine home is needed or read. A daemon that
 * connection started there stops when the UI quits; one that was running goes on.
 */
export async function runRemoteTui(host: string, opts: Opening = {}): Promise<void> {
	const { connectRemote, sshHost } = await import("../remote.ts");
	// What is no host for ssh is refused before anything else is looked at.
	if (!sshHost(host)) throw new Error("--ssh takes the machine, as you would write it after ssh: pine --ssh <host>");
	needsTerminal();
	process.stderr.write(`Connecting to the pine on ${host} over SSH…\n`);
	const r = await connectRemote(host);
	const client = new Client(r.base, r.token);
	return open(client, `on ${r.label} over SSH${r.started ? ", started here" : ""}`, () => r.stop(), opts, { remote: r.label, mcp: remoteMcp(client, host) });
}

/** The MCP servers of another machine's pine, as it has them (its control API). A browser sign-in has to happen on that machine. */
export function remoteMcp(client: Client, host: string): NonNullable<TuiOptions["mcp"]> {
	return {
		list: async (states = true) => {
			const servers = await client.get<Array<{ name: string; scope: string; session?: string; agents: string[]; target: string; remote?: boolean; enabled?: boolean }>>("/mcp");
			const found = states ? await client.get<Record<string, string>>("/mcp/states").catch(() => ({}) as Record<string, string>) : {};
			return servers.map((s) => ({ ...s, state: s.enabled === false ? "disabled" : states ? (found[s.name] ?? (s.remote ? "unknown" : "local")) : undefined }));
		},
		login: async (name, onOutput) => (onOutput(`A sign-in opens a browser on the machine whose pine it is. Run it there: ssh ${host} pine mcp login ${name}`), 1),
	};
}

function needsTerminal(): void {
	if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error("the terminal UI needs an interactive terminal");
}

/**
 * The ways the UI can end that nothing else ends for it: a signal, an exception in a timer callback
 * (the spinner, the programs of a conversation) and a rejection nobody caught. Left alone they take
 * the process with them and leave the alt screen, raw mode and the mouse tracking on the terminal
 * they were given. Each stops the app, which puts the terminal back before it waits for anything;
 * `report` is told what went wrong, to be said once the screen is the owner's own again. What is
 * returned takes the handlers off.
 *
 * Stopping waits for the daemon this process started, and nothing bounds how long that takes. So a
 * signal after a signal or a crash ends the process at once, and a stop begun by one that has not
 * ended after `waitMs` ends it all the same. After /quit the terminal is the owner's again, and
 * Ctrl-C is such a signal: the first one stops (nothing more to do) and starts that wait, a second
 * ends it.
 */
export function endOnFailure(
	app: Pick<PineTui, "stop">,
	opts: { report?: (why: string) => void; exit?: (code: number) => void; waitMs?: number } = {},
): () => void {
	const { report = () => {}, exit = (code: number) => process.exit(code), waitMs = 10_000 } = opts;
	let ending = false;
	let late: NodeJS.Timeout | undefined;
	const stop = (crash?: string): void => {
		// A crash while the terminal is being put back must not start stopping again.
		if (ending) return;
		ending = true;
		if (crash !== undefined) report(crash);
		late = setTimeout(() => exit(1), waitMs);
		late.unref();
		void app.stop().catch(() => {});
	};
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
	// Whoever sends a signal while the app is stopping already does not want to wait any longer.
	const onSignal = () => (ending ? exit(1) : stop());
	// An exception has no caller left to go on with, so the process ends with the app.
	const onCrash = (e: unknown) => stop(`\npine stopped: ${errText(e)}\n`);
	for (const signal of signals) process.on(signal, onSignal);
	process.on("uncaughtException", onCrash);
	process.on("unhandledRejection", onCrash);
	return () => {
		clearTimeout(late);
		for (const signal of signals) process.off(signal, onSignal);
		process.off("uncaughtException", onCrash);
		process.off("unhandledRejection", onCrash);
	};
}

async function open(client: Client, mode: string, stop: () => Promise<void>, opts: Opening, more: Pick<TuiOptions, "mcp" | "remote">): Promise<void> {
	const cleanup: Array<() => Promise<void> | void> = [stop];
	const done = Promise.withResolvers<void>();
	const app = new PineTui({
		client,
		terminal: new ProcessTerminal(),
		mode,
		...more,
		onQuit: async () => {
			for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
			done.resolve();
		},
	});
	// What a crash said goes onto the terminal once the app has given it back.
	let complaint = "";
	const off = endOnFailure(app, {
		report: (why) => {
			complaint = why;
			process.exitCode = 1;
		},
		// Ended before the stop was through: the terminal is the owner's again, and what went wrong is still said.
		exit: (code) => {
			if (complaint) process.stderr.write(complaint);
			process.exit(code);
		},
	});
	try {
		await app.start();
		// Started as "pine <folder>": the same tabs as always, and one on that folder.
		if (opts.folder) await app.openFolder(opts.folder, opts.worktree);
	} catch (e) {
		off();
		await app.stop();
		throw e;
	}
	await done.promise;
	off();
	if (complaint) process.stderr.write(complaint);
	process.exit(process.exitCode ?? 0);
}
