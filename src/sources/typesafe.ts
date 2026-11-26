import { Type } from "typebox";
import { isLocalHost, publicOnlyAgent } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { systemOne } from "./systemone.ts";

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
		try {
			const answers = await systemOne({ url: service.url, key, model, questions, data, signal, timeoutMs: pace.timeout, guard, retries: pace.retries, who: "TypeSafe" });
			source.status(`answers with ${model}`);
			return answers;
		} catch (e: any) {
			if (e?.status) source.status(e.status === 401 ? "TypeSafe did not accept the key" : `answers with ${model}; the last request failed (${e.status})`);
			throw e;
		}
	});
}
