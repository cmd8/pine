import { Type } from "typebox";
import { isLocalHost } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { guardFor } from "./stream.ts";
import { systemOne } from "./systemone.ts";

/**
 * A decision model on a server of the owner's own: answers the typed questions of routes that name
 * this source (`"ask": { "source": "<name>" }`, docs/references/events.md, "Typed questions"), as
 * `typesafe` does with TypeSafe's Jev, over the same API (POST <url>/v1/systemone). Pinecone serves
 * one that way. It reports nothing and listens to nothing; it only answers.
 *
 * options: { url, model, key?, local?, timeout? }
 *   url      the server's address, without /v1: http://studio.tail1234.ts.net:8080
 *   model    the model the server is to use, as it names it: "decider"
 *   key      its access token, if it wants one
 *   local    the server is on the owner's own network under a name that does not say so (a Tailscale
 *            name). Not needed for an IP address, localhost or a .local name
 *   timeout  how long a request may take, loading the model included: 120s
 *
 * The address is the one the owner confirmed, and the key goes there and nowhere a redirect says.
 * Unless the address is local, the connection stays on the public internet (the address guard).
 */
export const DEFAULT_TIMEOUT = 120;

export const type: SourceType = {
	summary: "a decision model on a server of your own that speaks TypeSafe's API (Pinecone does): answers routes' typed questions about events. Reports nothing",
	decides: "what a route asks about goes to the decision server at the source's url",
	options: Type.Object(
		{
			url: Type.String({ description: "the server's address, without /v1, e.g. http://studio.tail1234.ts.net:8080" }),
			model: Type.String({ description: 'the model the server answers with, as the server names it, e.g. "decider"' }),
			key: Type.Optional(Type.String({ description: "the server's access token, if it wants one", secret: true })),
			local: Type.Optional(Type.Boolean({ description: "true if the server is on your owner's own network under a name that does not say so, such as a Tailscale name. Not needed for an IP address, localhost or a .local name" })),
			timeout: Type.Optional(Type.Integer({ minimum: 5, maximum: 600, description: "how many seconds a request may take, loading the model included. Default 120" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		if (setup.key !== setup.name) throw new Error("routes ask only a source of all agents. Set the decider up for all agents");
		let url: URL;
		try {
			url = new URL(o.url);
		} catch {
			throw new Error(`"${o.url}" is not an address. A decision server's looks like http://studio.tail1234.ts.net:8080`);
		}
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with http:// or https://");
		if (url.username || url.password) throw new Error('an address with a user name or password in it is not taken: a token goes into "key"');
		if (url.search || url.hash) throw new Error("the address is the server's, without a query");
		const local = o.local === true || isLocalHost(url.hostname);
		if (url.protocol === "http:" && !local) throw new Error('a server that is not on your own network must be reached over https://. If it is on your network under a name that does not say so (a Tailscale name), set "local": true');
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (setup.controlPort && port === setup.controlPort && ["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("that is pine's own control port, not a decision server");
		if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(String(o.model ?? ""))) throw new Error(`"${o.model}" is not a model name, such as decider`);
		const base = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
		return {
			options: { ...o, url: base },
			does: [`answer the typed questions of routes that name it, with the model ${o.model} of the server at ${url.host}`, `what such a route asks about (the event's data) goes to ${url.host}${o.key ? ", with the key" : ""}${local ? ", on your own network" : ""}`],
			opens: true,
		};
	},
};

export default function decider(source: SourceApi): void {
	const o = source.options;
	const url = new URL(String(o.url ?? ""));
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
	const model = String(o.model ?? "");
	if (!model) throw new Error('needs "model": the model the server answers with');
	const key = typeof o.key === "string" && o.key ? o.key : undefined;
	source.secret(key);
	const timeoutMs = (Number.isInteger(o.timeout) ? o.timeout : DEFAULT_TIMEOUT) * 1000;
	const guard = guardFor(source, url.hostname, o.local, timeoutMs);
	const who = `the decision server at ${url.host}`;
	source.status(`answers with ${model}`);

	source.onDecide(async ({ questions, data, signal }) => {
		try {
			const answers = await systemOne({ url: base, key, model, questions, data, signal, timeoutMs, guard, retries: [1000, 3000], who });
			source.status(`answers with ${model}`);
			return answers;
		} catch (e: any) {
			source.status(e?.status === 401 || e?.status === 403 ? "the server did not accept the key" : e?.status === 404 ? `the server does not know the model ${model}` : `answers with ${model}; the last request failed${e?.status ? ` (${e.status})` : ""}`);
			throw e;
		}
	});
}
