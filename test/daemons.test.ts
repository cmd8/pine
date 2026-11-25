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

test("pine list finds a running pine start with its control API, and pine killall stops it", async () => {
	const h = await harness({ pine: { http: { port: 0 }, logLevel: "warn" }, agents: { main: {} }, start: false });
	const daemon = spawn(process.execPath, [CLI, "start", "--home", h.home], { stdio: "ignore" });
	const exited = new Promise<void>((r) => daemon.once("exit", () => r()));
	try {
		let found: Array<{ pid: number; how: string; home: string; base?: string }> = [];
		await until(
			async () => {
				found = JSON.parse(await cli(["list", "--json", "--home", h.home]));
				return found.some((d) => d.base);
			},
			30_000,
			"pine list to find the daemon",
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].pid, daemon.pid);
		assert.equal(found[0].how, "start");
		assert.equal(found[0].home, h.home);
		assert.equal((await fetch(`${found[0].base}/health`)).ok, true);

		const said = await cli(["killall", "--home", h.home]);
		assert.match(said, new RegExp(`(Stopped|Killed).*${daemon.pid}`));
		await exited;
		assert.equal((await cli(["list", "--home", h.home])).trim(), `No pine daemon runs for ${h.home}.`);
	} finally {
		daemon.kill("SIGKILL");
		await h.close();
	}
});

test("pine kill stops the daemon with that number, and refuses a number that is not a pine daemon", async () => {
	const h = await harness({ pine: { http: { port: 0 }, logLevel: "warn" }, agents: { main: {} }, start: false });
	const daemon = spawn(process.execPath, [CLI, "start", "--home", h.home], { stdio: "ignore" });
	const exited = new Promise<void>((r) => daemon.once("exit", () => r()));
	try {
		await until(async () => (JSON.parse(await cli(["list", "--json", "--home", h.home])) as Array<{ base?: string }>).some((d) => d.base), 30_000, "pine list to find the daemon");
		// This test's own process is Node, but not pine: it is not signalled.
		await assert.rejects(cli(["kill", String(process.pid)]), /is not a pine daemon/);
		await assert.rejects(cli(["kill", "nope"]), /usage: pine kill <pid>/);
		assert.match(await cli(["kill", String(daemon.pid)]), new RegExp(`(Stopped|Killed).*${daemon.pid}`));
		await exited;
	} finally {
		daemon.kill("SIGKILL");
		await h.close();
	}
});
