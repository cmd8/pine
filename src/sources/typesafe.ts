import { Type } from "typebox";
import { fetch } from "undici";
import type { AskQuestions } from "../ask.ts";
import { isLocalHost, publicOnlyAgent } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";

/**
 * Jev, TypeSafe's decision model: answers the typed questions of routes that name this source
 * (`"ask": { "source": "<name>" }`, docs/references/events.md, "Typed questions"). It reports
 * nothing and listens to nothing; it only answers.
 *
 * options: { key, model? }
 *   key    the account's API key (console.typesafe.ai)
 *   model  which of TypeSafe's models: jev-latest unless the owner names another
 *
 * Where it sends is fixed here, never an option: what a route asks about goes to TypeSafe's API
 * and nowhere else, with the key, through the address guard, and never along a redirect. Only a
 * test moves `service`. What TypeSafe answers is turned into pine's answers ({ yes }, { choice },
 * { score }), and the router keeps only what fits the questions (src/ask.ts). Nothing TypeSafe
 * writes in an error goes into a status line or an error of pine's: only its status code.
 * docs: https://docs.typesafe.ai/api/system-one.md
 */
export const service = { url: "https://api.typesafe.ai" };
/** How long one request may take, and the pauses before a request TypeSafe was too busy for is sent again. A test shortens them. */
export const pace = { timeout: 20_000, retries: [500, 1500] };

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const type: SourceType = {
	summary: "Jev, TypeSafe's decision model: answers routes' typed questions about events (a probability of yes, one of named options, a score on levels). Reports nothing",
	decides: "what a route asks about goes to TypeSafe (api.typesafe.ai)",
	options: Type.Object(
		{
			key: Type.String({ description: "the API key of your owner's TypeSafe account (console.typesafe.ai)", secret: true }),
			model: Type.Optional(Type.String({ description: "which of TypeSafe's models answers. Leave out for jev-latest" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		if (o.model !== undefined && !MODEL.test(String(o.model))) throw new Error(`"${o.model}" is not a TypeSafe model name, such as jev-latest. Leave "model" out for that one`);
		if (setup.agent && setup.key !== setup.name) throw new Error("routes ask only a source of all agents. Set Jev up for all agents");
		return {
			options: o,
			does: [
				`answer the typed questions of routes that name it, with TypeSafe's ${o.model ?? "jev-latest"}`,
				"what such a route asks about (the event's data) goes to TypeSafe at api.typesafe.ai, with your key",
			],
			opens: true,
		};
	},
};

const fromPine = (questions: AskQuestions) =>
	Object.fromEntries(
		Object.entries(questions).map(([name, q]) => [
			name,
			q.type === "yesno" ? { type: "noul", instructions: q.question } : q.type === "choice" ? { type: "choice", instructions: q.question, criteria: q.options } : { type: "score", instructions: q.question, criteria: q.levels },
		]),
	);

/** TypeSafe's answers in pine's words. What does not fit is left for the router to refuse. */
const toPine = (answers: Record<string, any>, questions: AskQuestions) =>
	Object.fromEntries(
		Object.entries(questions).map(([name, q]) => {
			const a = answers?.[name];
			if (!a || typeof a !== "object") return [name, undefined];
			const confidence = typeof a.confidence === "number" ? { confidence: a.confidence } : {};
			return [name, q.type === "yesno" ? { yes: a.noul } : q.type === "choice" ? { choice: a.choice, ...confidence } : { score: a.score, ...confidence }];
		}),
	);

const WHY: Record<number, string> = {
	400: "TypeSafe refused the request (400): the data may be longer than the model reads",
	401: "TypeSafe did not accept the key (401). Your owner sets a new one by removing this source and adding it again",
	413: "the data is too large for TypeSafe (413)",
	422: "TypeSafe did not take the questions (422)",
	429: "TypeSafe's rate limit was reached (429), also after waiting",
	529: "TypeSafe is overloaded (529), also after waiting",
};

export default function typesafe(source: SourceApi): void {
	const key = String(source.options.key ?? "");
	if (!key) throw new Error('needs "key": the API key of a TypeSafe account');
	source.secret(key);
	const model = typeof source.options.model === "string" && source.options.model ? source.options.model : "jev-latest";
	const at = new URL(service.url);
	const guard = isLocalHost(at.hostname) ? undefined : publicOnlyAgent(pace.timeout);
	if (guard) source.onStop(() => guard.close());
	source.status(`answers with ${model}`);

	source.onDecide(async ({ questions, data, signal }) => {
		const body = JSON.stringify({ model, state: data ?? "", questions: fromPine(questions) });
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(`${service.url}/v1/systemone`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body,
				// The key goes to the address it is for, and nowhere a redirect says.
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(pace.timeout)]),
				...(guard ? { dispatcher: guard } : {}),
			});
			if ((res.status === 429 || res.status === 529) && attempt < pace.retries.length) {
				await res.body?.cancel().catch(() => {});
				await new Promise((r) => setTimeout(r, pace.retries[attempt]));
				continue;
			}
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				source.status(res.status === 401 ? "TypeSafe did not accept the key" : `answers with ${model}; the last request failed (${res.status})`);
				throw new Error(WHY[res.status] ?? `TypeSafe answered ${res.status}`);
			}
			const answers = ((await res.json().catch(() => undefined)) as any)?.answers;
			if (!answers || typeof answers !== "object") throw new Error("TypeSafe answered without answers");
			source.status(`answers with ${model}`);
			return toPine(answers, questions);
		}
	});
}
