import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkRoute } from "../src/admin.ts";
import { harness, until } from "./support/harness.ts";

const noSandbox = process.platform === "win32" && "a route's command runs in the agent's sandbox, which Windows does not have (docs/adr/0004-three-systems.md)";

test("run: a route decides and runs a script with the answers, with no model turn for it; what the script prints goes on", { skip: noSandbox }, async () => {
	const h = await harness({
		pine: {
			routes: [
				{
					name: "judge",
					on: "ui/click",
					ask: { data: "{{payload.text}}", questions: { urgent: { type: "yesno", question: "Is it urgent?" } } },
					// A page's state written by a script of the agent's: no agent is woken for it.
					run: { command: "cat > ui/got.json && printf '{\"shown\": true}'" },
					set: { "agent/main/last": "{{output}}" },
					publish: { topic: "ui/shown" },
				},
			],
		},
		agents: { main: {} },
		mockOptions: { withoutTools: () => '{"urgent": {"yes": 0.93}}' },
	});
	fs.mkdirSync(path.join(h.workspace("main"), "ui"), { recursive: true });
	const shown = h.pine.bus.waitFor("ui/shown");
	h.pine.bus.publish("ui/click", { text: "the boiler is leaking" }, { source: "test" });
	const e = await shown;
	assert.deepEqual(e.payload, { answers: { urgent: { yes: 0.93 } }, output: { shown: true }, of: { text: "the boiler is leaking" } });
	assert.deepEqual(h.pine.state.get("agent/main/last"), { shown: true }, "{{output}}, parsed as JSON");
	const got = JSON.parse(fs.readFileSync(path.join(h.workspace("main"), "ui", "got.json"), "utf8"));
	assert.equal(got.topic, "ui/click");
	assert.deepEqual(got.payload, { text: "the boiler is leaking" });
	assert.deepEqual(got.answers, { urgent: { yes: 0.93 } });
	assert.equal(got.trust, "untrusted");
	assert.ok(typeof got.elapsedMs === "number" && got.elapsedMs >= 0, "how long since the event, for a page that shows it");
	assert.equal(h.pine.tasks.list({}).length, 0, "no agent was woken");
	await h.close();
});

test("run: the script runs in the agent's sandbox, also for an event from outside: pine's home stays closed, and a failure says why", { skip: noSandbox }, async () => {
	const h = await harness({ pine: { routes: [{ name: "evil", on: "hook/x", run: { command: "bash escape.sh" } }] }, agents: { main: {} } });
	const target = path.join(h.home, "pwned");
	fs.writeFileSync(path.join(h.workspace("main"), "escape.sh"), `echo pwned > '${target}' || { echo refused >&2; exit 3; }\n`);
	const failed = h.pine.bus.waitFor("pine/route-failed");
	h.pine.bus.publish("hook/x", { text: "go" }, { source: "http" });
	const error = ((await failed).payload as any).error;
	assert.match(error, /ended with 3: .*refused/s);
	assert.ok(!fs.existsSync(target), "nothing was written into pine's home");
	await h.close();
});

test("run: the command is fixed text, and the main agent is told where and how it runs", async () => {
	const h = await harness({ pine: { main: "main" }, agents: { main: {}, helper: {} } });
	const cfg = h.pine.cfg;
	const checked = checkRoute(cfg, { name: "page", on: "source/ui@main/message", run_command: "python3 ui/answer.py" }, []);
	assert.deepEqual(checked.entry.run, { command: "python3 ui/answer.py" });
	assert.ok(checked.lines.includes("run in main's sandbox and workspace, with no model: python3 ui/answer.py"));
	assert.ok(checked.lines.includes("it is given the event as JSON on stdin; what it prints is {{output}}"));
	assert.deepEqual(checkRoute(cfg, { name: "page2", on: "x/y", run_command: "sh a.sh", run_agent: "helper" }, []).entry.run, { command: "sh a.sh", agent: "helper" });
	assert.throws(() => checkRoute(cfg, { name: "page3", on: "x/y", run_command: "echo {{payload.text}}" }, []), /fixed text/, "nothing of an event goes into a command line");
	assert.throws(() => checkRoute(cfg, { name: "page4", on: "x/y", run_command: "sh a.sh", run_agent: "ghost" }, []), /no agent "ghost"/);
	await h.close();
});
