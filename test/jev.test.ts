import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { questionsProblem } from "../src/jev.ts";
import { audit } from "../src/security.ts";
import { type Harness, harness, until } from "./support/harness.ts";

delete process.env.TYPESAFE_API_KEY;

const KEY = "ts-test-key-0123456789";

async function typesafe(t: { after(fn: () => void): void }, opts: { noul?: (state: unknown) => number; busy?: number } = {}) {
	const asked: any[] = [];
	let busy = opts.busy ?? 0;
	const server = http.createServer((req, res) => {
		const send = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
		if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: "Invalid API key" });
		if (req.method === "GET" && req.url === "/v1/models") return send(200, { data: [{ id: "jev-latest" }] });
		let text = "";
		req.on("data", (c) => (text += c));
		req.on("end", () => {
			if (req.url !== "/v1/systemone") return send(404, { detail: "no such path" });
			if (busy-- > 0) return send(529, { detail: "Overloaded" });
			const body = JSON.parse(text);
			asked.push(body);
			const answers = Object.fromEntries(
				Object.entries<any>(body.questions).map(([name, q]) => [
					name,
					q.type === "noul" ? { type: "noul", noul: (opts.noul ?? (() => 0.5))(body.state) } : q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.7, probabilities: {} } : { type: "score", score: 1.5, confidence: 0.6 },
				]),
			);
			send(200, { model: "jev-1", answers, usage: { input_tokens: 10, output_tokens: 2 } });
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, asked };
}

const api = (h: Harness) => {
	const base = `http://127.0.0.1:${h.pine.http!.port}`;
	const call = async (method: string, url: string, body?: unknown) => {
		const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${h.pine.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
	};
	return { get: (url: string) => call("GET", url), post: (url: string, body: unknown = {}) => call("POST", url, body) };
};

const urgent = { urgent: { type: "noul", instructions: "Does this need an answer today?" } };

test("a route asks Jev about an event, and a second route filters on the answer as a number", async (t) => {
	const ts = await typesafe(t, { noul: (state: any) => (/today/.test(JSON.stringify(state)) ? 0.93 : 0.08), busy: 1 });
	const h = await harness({
		pine: {
			jev: { baseUrl: ts.baseUrl },
			routes: [
				{ name: "judge", on: "mail/new", jev: { questions: { ...urgent, kind: { type: "choice", instructions: "What is it?", criteria: { invoice: "A bill to pay", other: "Anything else" } } } }, publish: { topic: "mail/judged" } },
				{ name: "act", on: "mail/judged", when: { "payload.answers.urgent.noul": { gte: 0.8 } }, publish: { topic: "mail/urgent", payload: { subject: "{{payload.of.subject}}", kind: "{{payload.answers.kind.choice}}" } } },
				{ name: "text", on: "note/new", jev: { state: "{{payload.text}}", questions: urgent }, publish: { topic: "note/judged", payload: { p: "{{jev.urgent.noul}}" } } },
			],
		},
		files: { ".env": `TYPESAFE_API_KEY=${KEY}\n` },
		agents: { main: {} },
	});
	const urgentMail: any[] = [];
	const judged: any[] = [];
	h.pine.bus.subscribe("mail/urgent", (e) => void urgentMail.push(e.payload));
	h.pine.bus.subscribe("mail/judged", (e) => void judged.push(e));

	const first = h.pine.bus.publish("mail/new", { subject: "Lunch some time?", text: "No hurry." }, { source: "test" });
	h.pine.bus.publish("mail/new", { subject: "Contract", text: "Sign it today, please." }, { source: "test" });
	await until(() => judged.length === 2 && urgentMail.length === 1);
	assert.deepEqual(urgentMail, [{ subject: "Contract", kind: "invoice" }], "only the mail Jev called urgent got through");
	const calm = judged.find((e) => e.cause === first.id)!.payload as any;
	assert.deepEqual(calm.answers.urgent, { type: "noul", noul: 0.08 }, "the answers go out as Jev gave them");
	assert.deepEqual(calm.of, { subject: "Lunch some time?", text: "No hurry." }, "with the event they are about");
	assert.equal(judged[0].trust, "untrusted", "and what is published keeps the event's trust");
	assert.ok(ts.asked.some((q) => JSON.stringify(q.state) === JSON.stringify({ subject: "Lunch some time?", text: "No hurry." })), "without a state of its own, Jev is asked about the payload");
	assert.equal(ts.asked[0].model, "jev-latest");
	assert.equal(ts.asked.length, 2, "a busy answer (529) was tried again, and counted once");

	const noted = h.pine.bus.waitFor("note/judged");
	h.pine.bus.publish("note/new", { text: "Call back today" }, { source: "test" });
	assert.deepEqual((await noted).payload, { p: 0.93 }, "{{jev.<name>}} is the answer, a number where it stands alone");
	assert.equal(ts.asked.at(-1).state, "Call back today", "a state of the route's own is rendered from the event");
	assert.ok(!JSON.stringify(h.pine.bus.query({ limit: 100 })).includes(KEY), "the key is in no event");
	await h.close();
});

test("without a key a route that asks Jev fails and says so, and pine check names it", async (t) => {
	const ts = await typesafe(t);
	const h = await harness({ pine: { jev: { baseUrl: ts.baseUrl }, routes: [{ name: "judge", on: "mail/new", jev: { questions: urgent }, publish: { topic: "mail/judged" } }] }, agents: { main: {} } });
	const failed = h.pine.bus.waitFor("pine/route-failed");
	h.pine.bus.publish("mail/new", { subject: "x" }, { source: "test" });
	const e = (await failed).payload as any;
	assert.equal(e.route, "judge");
	assert.match(e.error, /Jev has no key/);
	assert.equal(ts.asked.length, 0, "TypeSafe was not asked");
	assert.ok(audit(h.pine.cfg).some((line) => /route "judge" asks Jev, and there is no key/.test(line)));
	await h.close();
});

test("the owner sets the key through the control API; only then a route may ask Jev, and the key stays while one does", async (t) => {
	const ts = await typesafe(t);
	const h = await harness({ pine: { http: { port: 0 }, jev: { baseUrl: ts.baseUrl } }, agents: { main: {} } });
	const a = api(h);
	const route = { name: "judge", on: "mail/new", jev_questions: JSON.stringify(urgent), publish_topic: "mail/judged" };

	assert.deepEqual((await a.get("/models/jev")).body, { signedIn: false, model: "jev-latest", host: new URL(ts.baseUrl).host, routes: [] });
	const early = await a.post("/routes", route);
	assert.equal(early.status, 400);
	assert.match(early.body.error, /Jev has no key yet, so no route can ask it/);

	const wrong = await a.post("/models/jev", { key: "not-the-right-key" });
	assert.equal(wrong.status, 409);
	assert.match(wrong.body.error, /did not accept that key/);
	assert.ok(!fs.existsSync(path.join(h.home, ".env")) || !fs.readFileSync(path.join(h.home, ".env"), "utf8").includes("TYPESAFE"), "a key TypeSafe refused is not kept");

	assert.deepEqual((await a.post("/models/jev", { key: KEY })).body, { signedIn: true, model: "jev-latest" });
	const env = path.join(h.home, ".env");
	assert.match(fs.readFileSync(env, "utf8"), new RegExp(`^TYPESAFE_API_KEY=${KEY}$`, "m"));
	if (process.platform !== "win32") assert.equal(fs.statSync(env).mode & 0o777, 0o600);
	assert.ok(!JSON.stringify((await a.get("/models/jev")).body).includes(KEY), "the key is never handed out again");

	for (const [questions, said] of [
		["[]", /must be a JSON object/],
		["{}", /at least one question/],
		['{"q": {"type": "box"}}', /needs a "type": noul, choice, score/],
		['{"q": {"type": "choice"}}', /needs "criteria": the options/],
		['{"q": {"type": "score", "criteria": ["one"]}}', /the levels as a list/],
	] as const)
		assert.match((await a.post("/routes", { ...route, jev_questions: questions })).body.error, said);
	assert.match((await a.post("/routes", { ...route, publish_topic: undefined })).body.error, /give "publish_topic"/);
	assert.match((await a.post("/routes", { ...route, agent: "main" })).body.error, /asks Jev or wakes an agent, not both/);
	assert.match((await a.post("/routes", { ...route, call_prompt: "And you?" })).body.error, /a model or Jev, not both/);

	const made = (await a.post("/routes", route)).body;
	assert.deepEqual(made.lines, ["on mail/new", "ask Jev (TypeSafe) about the event: urgent (yes or no): Does this need an answer today?", `this sends each such event to TypeSafe (${new URL(ts.baseUrl).host})`, "publish the event mail/judged"]);
	assert.deepEqual(((await a.get("/routes")).body as any[])[0].jev, { questions: urgent });
	const judged = h.pine.bus.waitFor("mail/judged");
	h.pine.bus.publish("mail/new", { subject: "x" }, { source: "test" });
	assert.equal(((await judged).payload as any).answers.urgent.noul, 0.5, "the route works at once, with the key that was just set");

	const held = await a.post("/models/jev/remove");
	assert.equal(held.status, 409);
	assert.deepEqual(held.body.users, ["judge"]);
	await a.post("/routes/remove", { name: "judge" });
	assert.deepEqual((await a.post("/models/jev/remove")).body, { signedIn: false });
	assert.ok(!fs.readFileSync(env, "utf8").includes("TYPESAFE"));
	assert.equal((await a.post("/routes", route)).status, 400, "and without the key no route asks Jev again");
	await h.close();
});

test("questions are named, typed and complete", () => {
	assert.equal(questionsProblem({ urgent: { type: "noul", instructions: "Urgent?" }, kind: { type: "choice", criteria: { a: "A", b: null } }, level: { type: "score", criteria: ["low", "high"] } }), undefined);
	assert.match(questionsProblem({ "two words": { type: "noul", instructions: "x" } })!, /not a usable name/);
	assert.match(questionsProblem({ q: { type: "noul" } })!, /needs "instructions"/);
	assert.match(questionsProblem("urgent?")!, /are an object/);
});
