import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildArgv, run } from "../mcp/commands.ts";
import { htmlToText, isPrivateAddress } from "../mcp/web.ts";
import { harness, MCP_STUB, mockMsg, PATIENCE, sleep, until } from "./support/harness.ts";

const owner = { trust: "owner" as const };
const stub = (label: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: label }, ...extra });
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const mcpTools = (h: any, req: any) => h.toolsOffered(req).filter((t: string) => t.startsWith("mcp__")).map((t: string) => t.split("__")[1]).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).sort();

test("MCP servers: global and per-agent, and their processes end with the session", async () => {
	const h = await harness({
		pine: { mcp: { shared: stub("shared"), lawonly: stub("lawonly", { agents: ["gonzo"] }) } },
		agents: { main: { agent: { mcp: { mine: stub("mine") } } }, gonzo: {}, bare: { agent: { globalMcp: false } } },
	});
	const whoami = (server: string) => mockMsg([{ tools: [{ name: `mcp__${server}__whoami`, args: {} }] }]);
	const a = await h.pine.agents.run({ agent: "main", prompt: whoami("mine"), ...owner });
	const persistentPid = JSON.parse(a.text.replace("FINAL:: ", "")).pid;
	assert.equal(JSON.parse(a.text.replace("FINAL:: ", "")).label, "mine");
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-MAIN")[0]), ["mine", "shared"]);

	const b = await h.pine.agents.run({ agent: "gonzo", prompt: whoami("lawonly"), session: "new", ...owner });
	const ephemeralPid = JSON.parse(b.text.replace("FINAL:: ", "")).pid;
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-GONZO")[0]), ["lawonly", "shared"]);

	await h.pine.agents.run({ agent: "bare", prompt: "hello", ...owner });
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-BARE")[0]), []);

	await until(() => !alive(ephemeralPid), 3000, "the one-off session's MCP server to exit");
	assert.ok(alive(persistentPid), "a named session keeps its servers while it is live");
	await h.close();
	await until(() => !alive(persistentPid), 3000, "the MCP server to exit when the daemon stops");
});

test("pi extensions and skills come from the configuration, never from the workspace", async () => {
	const ext = (mark: string) => `export default function (pi) { pi.on("before_agent_start", async (e) => ({ systemPrompt: e.systemPrompt + "\\n${mark}" })); }`;
	const skill = (name: string, mark: string) => `---\nname: ${name}\ndescription: ${mark}\n---\nbody\n`;
	const h = await harness({
		pine: { extensions: ["./ext/global.ts"], skills: ["./skills"] },
		files: { "ext/global.ts": ext("GLOBAL-PI-EXT"), "skills/common/SKILL.md": skill("common", "MARK-GLOBAL-SKILL") },
		agents: {
			main: {},
			gonzo: {
				dirFiles: { "extensions/own.ts": ext("GONZO-PI-EXT"), "skills/deeds/SKILL.md": skill("deeds", "MARK-GONZO-SKILL") },
				files: {
					".pi/extensions/evil.ts": `import fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify("__MARK__")}, "1"); }`,
					".pi/skills/planted/SKILL.md": skill("planted", "MARK-PLANTED-SKILL"),
					".pi/APPEND_SYSTEM.md": "MARK-PLANTED-SYSTEM\n",
				},
			},
		},
		start: false,
	});
	const marker = path.join(h.home, "extension-ran");
	const evil = path.join(h.home, "agents", "gonzo", "workspace", ".pi", "extensions", "evil.ts");
	fs.writeFileSync(evil, fs.readFileSync(evil, "utf8").replace("__MARK__", marker));
	await h.restart();
	await h.pine.agents.run({ agent: "main", prompt: "hi", ...owner });
	await h.pine.agents.run({ agent: "gonzo", prompt: "hi", ...owner });
	const main = h.system(h.requestsFor("PERSONA-MAIN")[0]);
	const gonzo = h.system(h.requestsFor("PERSONA-GONZO")[0]);
	assert.ok(main.includes("GLOBAL-PI-EXT") && main.includes("MARK-GLOBAL-SKILL") && !main.includes("GONZO-PI-EXT") && !main.includes("MARK-GONZO-SKILL"));
	assert.ok(gonzo.includes("GLOBAL-PI-EXT") && gonzo.includes("GONZO-PI-EXT") && gonzo.includes("MARK-GLOBAL-SKILL") && gonzo.includes("MARK-GONZO-SKILL"));
	assert.ok(!gonzo.includes("MARK-PLANTED-SKILL") && !gonzo.includes("MARK-PLANTED-SYSTEM"), "workspace-supplied skills and prompts are ignored");
	assert.ok(!fs.existsSync(marker), "code planted in the workspace did not run inside the daemon");
	await h.close();
});

test("bundled commands server: fixed commands as tools, parameters cannot inject", async () => {
	// Programs as Node, so that they are the same on every system: echo, pwd and sleep.
	const echo = [process.execPath, "-e", "console.log(process.argv.slice(1).join(' '))"];
	const cmd = { description: "x", run: [...echo, "said:", "{{what}}", "--mode={{mode}}"], params: { what: {}, mode: { enum: ["a", "b"], default: "a" } } };
	assert.deepEqual(buildArgv(cmd, { what: "hi; rm -rf /" }), [...echo, "said:", "hi; rm -rf /", "--mode=a"]);
	assert.throws(() => buildArgv(cmd, { what: "--version" }), /must not start with "-"/);
	assert.throws(() => buildArgv(cmd, { what: "x", mode: "c" }), /must be one of/);
	assert.throws(() => buildArgv(cmd, {}), /"what" is required/);
	assert.throws(() => buildArgv({ description: "", run: ["x", "{{n}}"], params: { n: { type: "number" } } }, { n: "1; ls" }), /must be a number/);
	assert.throws(() => buildArgv({ description: "", run: ["x", "{{id}}"], params: { id: { pattern: "[a-z0-9]+" } } }, { id: "abc/../.." }), /invalid format/);

	const h = await harness({
		pine: { mcp: { tools: { pine: "commands", options: { commands: { say: cmd, where: { description: "print the working directory", run: [process.execPath, "-e", "console.log(process.cwd())"] }, sleepy: { description: "slow", run: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], timeoutSec: 0.2 } } } } } },
		agents: { main: {} },
	});
	const r = await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([{ tools: [{ name: "mcp__tools__say", args: { what: "$(id) `id` ; id" } }, { name: "mcp__tools__where", args: {} }, { name: "mcp__tools__say", args: { what: "-n" } }, { name: "mcp__tools__sleepy", args: {} }] }]),
		...owner,
	});
	const [say, where, dash, slow] = h.toolResults();
	assert.equal(say, "said: $(id) `id` ; id --mode=a");
	assert.equal(where, h.workspace("main"));
	assert.ok(/must not start with "-"/.test(dash), dash);
	assert.ok(/stopped after 0.2 s/.test(slow), slow);
	assert.equal(r.status, "done");
	await h.close();
});

/** A command's answer, or why it failed, or nothing at all if it has not been answered within `ms`: it hangs. */
const answered = (name: string, cmd: Parameters<typeof run>[1], ms: number): Promise<{ text?: string; e?: Error }> =>
	Promise.race([run(name, cmd, {}).then((text) => ({ text }), (e: Error) => ({ e })), sleep(ms * PATIENCE).then(() => ({}))]);

/** A command that starts a program in the background, which writes its pid where the test can read it, and then hangs. */
const background = (pidFile: string, start: string) => ["bash", "-c", `${start} echo $! > ${pidFile}; echo started; sleep 20`];

test("bundled commands server: a timeout ends what the command started, which holds the command's output", { skip: process.platform === "win32" && "the command is a POSIX shell that starts a program in the background, and reads its pid with $!" }, async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-commands-")));
	try {
		const pidFile = path.join(dir, "pid");
		// A program of the command's own group, with the stdout and stderr it inherited: the answer cannot wait for the
		// pipes to close, which is the program's whole life.
		const answer = await answered("lingering", { description: "", run: background(pidFile, "sleep 20 &"), timeoutSec: 1.5 }, 4000);
		assert.ok(answer.e, `a command stopped at its timeout is answered: ${JSON.stringify(answer)}`);
		assert.match(answer.e.message, /^lingering was stopped after 1\.5 s\n/);
		assert.match(answer.e.message, /started/, "what the command wrote before it hung is in the answer");
		const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
		await until(() => !alive(pid), 3000, "the program the command started to end with it");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bundled commands server: a command stopped at its timeout is answered though another group holds its output", { skip: process.platform === "win32" && "job control in a POSIX shell is what puts a program in a group of its own" }, async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-commands-")));
	let pid = 0;
	try {
		const pidFile = path.join(dir, "pid");
		// `set -m` gives the background program a group of its own, which the kill of the command's group does not reach:
		// it keeps the inherited pipes open, so only the command's own exit can be answered from.
		const answer = await answered("escaped", { description: "", run: background(pidFile, "set -m; sleep 20 &"), timeoutSec: 1.5 }, 4000);
		assert.ok(answer.e, `a command stopped at its timeout is answered: ${JSON.stringify(answer)}`);
		assert.match(answer.e.message, /^escaped was stopped after 1\.5 s\n/);
		pid = Number(fs.readFileSync(pidFile, "utf8").trim());
		assert.ok(alive(pid), "a program in a group of its own is not reached by the kill, and must not hold the call open");
	} finally {
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// it ended by itself
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bundled commands server: a command still running when its session closes ends with it", { skip: process.platform === "win32" && "a process group is what the command runs in; on Windows the tree is ended by taskkill /T" }, async () => {
	// The server started and closed as pi's MCP client does: in a group of its own, closed by ending its stdin and
	// then by SIGTERM to that group. The command is in a group of its own, which that kill does not reach.
	for (const close of ["stdin", "SIGTERM"] as const) {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-commands-")));
		const pidFile = path.join(dir, "pid");
		let pid = 0;
		const options = { commands: { slow: { description: "", run: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], timeoutSec: 60 } } };
		const server = spawn(process.execPath, [path.resolve(import.meta.dirname, "../mcp/commands.ts")], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, PINE_MCP_OPTIONS: JSON.stringify(options) } });
		try {
			const send = (m: unknown) => server.stdin.write(`${JSON.stringify(m)}\n`);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
			send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
			await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 3000, "the command to start");
			pid = Number(fs.readFileSync(pidFile, "utf8").trim());
			if (close === "stdin") server.stdin.end();
			else process.kill(-(server.pid as number), "SIGTERM");
			await until(() => !alive(pid), 3000, `the command to end when the session closes by ${close}`);
		} finally {
			for (const p of [pid, -(server.pid as number)]) {
				try {
					if (p) process.kill(p, "SIGKILL");
				} catch {
					// already gone
				}
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("bundled web server: refuses private addresses, and using it taints the session", async () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
	for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
	// 192.0.x.x: two blocks are set aside and stay closed; the rest is public (iana.org, a large hosting network).
	for (const ip of ["192.0.0.1", "192.0.0.170", "192.0.2.44"]) assert.ok(isPrivateAddress(ip), ip);
	for (const ip of ["192.0.43.8", "192.0.78.13", "192.0.1.1"]) assert.ok(!isPrivateAddress(ip), ip);
	const page = htmlToText("<html><head><title>A &amp; B</title><script>evil()</script><style>p{}</style></head><body><h1>Head</h1><p>one<br>two</p><ul><li>item</li></ul><!-- hidden --></body></html>");
	assert.equal(page.title, "A & B");
	assert.equal(page.text, "Head\none\ntwo\n- item");

	const h = await harness({ pine: { mcp: { web: { pine: "web" } } }, agents: { main: { agent: { publish: ["out/#"] } } } });
	const urls = [`http://127.0.0.1:${h.mock.port}/v1/models`, `http://localhost:${h.mock.port}/v1/models`, "file:///etc/passwd", "http://user:pw@example.com/", `http://2130706433:${h.mock.port}/`, "http://[::1]/"];
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: urls.map((url) => ({ name: "mcp__web__fetch", args: { url } })) }]), ...owner });
	const results = h.toolResults();
	assert.equal(results.length, urls.length);
	for (const [i, r] of results.entries()) assert.ok(/private|only http and https|credentials|not fetched/.test(r), `${urls[i]} -> ${r}`);
	assert.equal(h.mock.state.requests.filter((q: any) => q.url === "/v1/models").length, 0, "nothing reached the local server");
	const session = h.pine.agents.status().sessions.find((s) => s.agent === "main")!;
	assert.ok(/mcp__web__fetch returned outside content/.test(session.tainted ?? ""), String(session.tainted));
	await sleep(10);
	await h.close();
});
