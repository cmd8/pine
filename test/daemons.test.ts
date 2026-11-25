// `pine list` and `pine killall` find pine's daemons in the system's list of processes. What a
// process is to pine is read from its arguments (all three systems' forms), and a real `pine start`
// is found and stopped. Every run here names its home with --home, so that the owner's daemons are
// never touched.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { macArgv, pineProcess, windowsArgv } from "../src/daemons.ts";
import { harness, until } from "./support/harness.ts";

const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const COMMANDS = new Set(["start", "service", "tui", "status", "events", "list", "killall", "send"]);

test("pine's processes are told by Node running pine's command line, and nothing else", () => {
	const is = (argv: string[]) => pineProcess(argv, COMMANDS);
	assert.deepEqual(is(["/opt/homebrew/bin/node", "/Users/a/dev/pine/bin/pine.js", "service"]), { how: "service", home: undefined, command: "pine service" });
	assert.equal(is(["node", "/usr/local/bin/pine", "start", "--home", "/srv/pine"])?.home, "/srv/pine");
	assert.equal(is(["node", "--enable-source-maps", "/x/node_modules/@pmndre/pine/src/cli.js", "--home=/h"])?.how, "tui");
	assert.equal(is(["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@pmndre\\pine\\bin\\pine.js", "start"])?.how, "start");
	// The terminal UI, with or without a folder: it may hold a daemon.
	assert.equal(is(["node", "/p/src/cli.ts"])?.how, "tui");
	assert.equal(is(["node", "/p/src/cli.ts", "~/dev/project", "--worktree"])?.how, "tui");
	// Clients of a daemon, the terminal UI of another machine, and what only mentions pine.
	assert.equal(is(["node", "/p/bin/pine.js", "status"]), undefined);
	assert.equal(is(["node", "/p/bin/pine.js", "events", "-f"]), undefined);
	assert.equal(is(["node", "/p/bin/pine.js", "--ssh", "box"]), undefined);
	assert.equal(is(["/opt/homebrew/bin/limactl", "hostagent", "--pidfile", "/Users/a/.lima/pine/ha.pid", "pine"]), undefined);
	assert.equal(is(["vim", "/Users/a/.pine/pine.json"]), undefined);
	assert.equal(is(["node", "/Users/a/dev/pine/scripts/test.mjs"]), undefined);
});

test("command lines are split back into arguments as each system writes them", () => {
	// macOS: ps quotes nothing, so a space in a path is found by the shape of pine's command line.
	assert.deepEqual(macArgv("/Applications/Pine.app/Contents/Resources/node/bin/node /Users/a/Library/Application Support/x/pine/bin/pine.js service --home /Users/a/.pine"), ["/Applications/Pine.app/Contents/Resources/node/bin/node", "/Users/a/Library/Application Support/x/pine/bin/pine.js", "service", "--home", "/Users/a/.pine"]);
	// Windows: quotes group.
	assert.deepEqual(windowsArgv('"C:\\Program Files\\nodejs\\node.exe"  "C:\\a b\\pine\\bin\\pine.js" start --home "C:\\my home"'), ["C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\pine\\bin\\pine.js", "start", "--home", "C:\\my home"]);
});

const cli = (args: string[]) =>
	new Promise<string>((resolve, reject) => execFile(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 }, (e, stdout, stderr) => (e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(stdout))));

type Listed = { pid: number; how: string; home: string; base?: string };
const listed = async (home: string): Promise<Listed[]> => JSON.parse(await cli(["list", "--json", "--home", home]));

/**
 * A real `pine start` on a home of its own, once `pine list` sees its control API. What is checked
 * is what happened (the process ended, the list is empty), never how pine words it: the wording
 * changes, on Windows a path is printed differently, and neither says whether it works.
 */
async function running() {
	const h = await harness({ pine: { http: { port: 0 }, logLevel: "warn" }, agents: { main: {} }, start: false });
	const daemon = spawn(process.execPath, [CLI, "start", "--home", h.home], { stdio: "ignore" });
	const gone = () => daemon.exitCode !== null || daemon.signalCode !== null;
	let found: Listed[] = [];
	try {
		await until(async () => (found = await listed(h.home)).some((d) => d.base) || gone(), 30_000, "pine list to find the daemon");
		assert.equal(gone(), false, "pine start ended by itself");
	} catch (e) {
		daemon.kill("SIGKILL");
		await h.close();
		throw e;
	}
	return {
		h,
		daemon,
		found,
		/** Waits until the daemon's process has ended. */
		ended: () => until(gone, 30_000, "the daemon to end"),
		close: async () => {
			daemon.kill("SIGKILL");
			await h.close();
		},
	};
}

test("pine list finds a running pine start with its control API, and pine killall stops it", async () => {
	const d = await running();
	try {
		assert.equal(d.found.length, 1, JSON.stringify(d.found));
		assert.equal(d.found[0].pid, d.daemon.pid);
		assert.equal(d.found[0].how, "start");
		assert.equal((await fetch(`${d.found[0].base}/health`)).ok, true);

		await cli(["killall", "--home", d.h.home]);
		await d.ended();
		assert.deepEqual(await listed(d.h.home), []);
	} finally {
		await d.close();
	}
});

test("pine kill stops the daemon with that number, and refuses a number that is not a pine daemon", async () => {
	const d = await running();
	try {
		// This test's own process is Node, but not pine; and a word is no number. Both are refused, and the daemon runs on.
		await assert.rejects(cli(["kill", String(process.pid)]));
		await assert.rejects(cli(["kill", "nope"]));
		assert.equal((await listed(d.h.home)).length, 1);

		await cli(["kill", String(d.daemon.pid)]);
		await d.ended();
		assert.deepEqual(await listed(d.h.home), []);
	} finally {
		await d.close();
	}
});
