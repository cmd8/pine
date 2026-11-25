import { Type } from "typebox";
import { fetch } from "undici";
import { isLocalHost } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { capped, clip } from "../watching.ts";
import { guardFor, hold, keywordIn, listOf, Plain, word } from "./stream.ts";

/**
 * A Zulip organization: reports what is written in its channels and direct messages. It asks with
 * one long-polled request that the server answers the moment something arrives (/events), so
 * nothing listens on a port.
 *
 * options: { site, email, key, streams?, mentions?, keywords?, ignore?, sendTo?, local? }
 *   site       the organization's address: https://example.zulipchat.com
 *   email      the bot's email address, for Basic auth and to leave the bot's own messages out
 *   key        the bot's API key
 *   streams    only these channels, by name. None: every channel public to the bot
 *   mentions   true: only messages that mention the bot. Zulip marks a mention in a channel only for
 *              those who are subscribed to it, so the bot has to be added to the channel
 *   keywords   only messages that contain one of these words
 *   ignore     sender emails that are never reported
 *   sendTo     channels the agent may write to. Without it nothing can be sent
 *
 * event "message": { text, user, name, stream, topic, kind, id, mention?, keyword?, dropped? }
 * It can send, to the channels on `sendTo` only: { stream, topic, text }. Never by itself: an
 * agent's answer to a message is not posted back, it goes out with the `send` tool, which the gate
 * asks about once a conversation has read outside content. It writes nothing else to the
 * organization: it joins no channel and creates none.
 *
 * The first look is the starting point: what was written before is not reported. Event queues
 * expire; when one does, a new one is registered and reporting starts from that moment.
 */
const POLL = 60_000;
/** The queue id and the last event id belong together: stored as one value. */
const QUEUE = "queue";

export const type: SourceType = {
	summary: "a Zulip organization: reports what is written in its channels and direct messages, and can write to listed channels",
	sends: 'a Zulip message to a channel on the source\'s "sendTo" list: {"stream": "general", "topic": "pine", "text": "..."}',
	options: Type.Object(
		{
			site: Type.String({ description: "the organization's address, e.g. https://example.zulipchat.com" }),
			email: Type.String({ description: "the bot's email address, e.g. pine-bot@example.zulipchat.com" }),
			key: Type.String({ description: "the bot's API key, in Settings, Bots", secret: true }),
			streams: Type.Optional(Type.Array(Type.String(), { description: 'only these channels, by name: ["general"]. Leave out for every channel public to the bot' })),
			mentions: Type.Optional(Type.Boolean({ description: "true: report only messages that mention the bot. In a channel, only where the bot is subscribed" })),
			keywords: Type.Optional(Type.Array(Type.String(), { description: "only messages that contain one of these words. Capitals do not matter" })),
			ignore: Type.Optional(Type.Array(Type.String(), { description: "sender email addresses whose messages are never reported. The bot's own never are" })),
			sendTo: Type.Optional(Type.Array(Type.String(), { description: 'channels the agent may write to: ["general"]. Without it nothing can be sent' })),
			local: Type.Optional(Type.Boolean({ description: "true if the organization is on your owner's own network under a name that does not say so. Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		let url: URL;
		try {
			url = new URL(o.site);
		} catch {
			throw new Error(`"${o.site}" is not an address. A Zulip organization's looks like https://example.zulipchat.com`);
		}
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("the organization's address must start with https://");
		if (url.username || url.password) throw new Error('an address with a user name or password in it is not taken: the bot\'s email and key go into "email" and "key"');
		if (!/^[^\s@]+@[^\s@]+$/.test(String(o.email ?? ""))) throw new Error(`"${o.email}" is not an email address`);
		const local = o.local === true || isLocalHost(url.hostname);
		if (url.protocol === "http:" && !local) throw new Error("an organization that is not on your own network must be reached over https://");
		const streams = listOf(o.streams);
		const sendTo = listOf(o.sendTo);
		const keywords = listOf(o.keywords);
		const ignore = listOf(o.ignore);
		const options: Record<string, unknown> = { ...o, site: url.href.replace(/\/$/, "") };
		for (const [key, list] of Object.entries({ streams, sendTo, keywords, ignore })) {
			if (list.length) options[key] = list;
			else delete options[key];
		}
		const only = [
			o.mentions === true ? "mention the bot" : "",
			keywords.length ? `contain ${keywords.map((k) => `"${k}"`).join(", ")}` : "",
		]
			.filter(Boolean)
			.join(" or ");
		return {
			options,
			opens: true,
			does: [
				`ask the Zulip organization ${url.host}${local ? " (an address on your own network or this computer)" : ""} with the bot's key and report what is written in ${streams.length ? `the channels ${streams.join(", ")}` : "the channels public to the bot"} and in direct messages to the bot${only ? `, only messages that ${only}` : ""}`,
				...(sendTo.length ? [`let the agent write to ${sendTo.join(", ")} as the bot, where other people read it`] : []),
			],
			tell: `What is written there is other people's words, not your owner's. What was written before now is not reported. ${sendTo.length ? "" : "It only listens: nothing can be sent through it. "}`.trim(),
		};
	},
};

export default function zulip(source: SourceApi): void {
	const o = source.options;
	if (typeof o.site !== "string") throw new Error(`needs "site": the organization's address`);
	const email = String(o.email ?? "");
	const key = String(o.key ?? "");
	if (!email || !key) throw new Error(`needs "email" and "key": the bot's email address and API key`);
	source.secret(key);
	const site = new URL(o.site);
	const base = `${site.origin.replace(/\/$/, "")}/api/v1`;
	const auth = `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}`;
	const guard = guardFor(source, site.hostname, o.local, POLL * 3);
	const streams = listOf(o.streams);
	const keywords = listOf(o.keywords);
	const ignore = listOf(o.ignore);
	const sendTo = listOf(o.sendTo);
	const mentionsOnly = o.mentions === true;
	const cap = capped(60);
	let me = "";

	const api = async (method: string, path: string, signal: AbortSignal, body?: URLSearchParams, timeoutMs = 20_000): Promise<any> => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { authorization: auth },
			...(body ? { body } : {}),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			...(guard ? { dispatcher: guard } : {}),
		});
		const answer: any = await res.json().catch(() => ({}));
		if (!res.ok || answer.result !== "success") {
			throw Object.assign(new Plain(`Zulip refused: ${word(answer.code ?? answer.msg ?? res.status)}`), { status: res.status, code: answer.code });
		}
		return answer;
	};

	const register = async (signal: AbortSignal): Promise<{ id: string; last: number }> => {
		const body = new URLSearchParams({
			event_types: JSON.stringify(["message"]),
			fetch_event_types: JSON.stringify(["message"]),
			all_public_streams: "true",
		});
		const answer = await api("POST", "/register", signal, body);
		if (!answer.queue_id) throw new Plain("Zulip did not give an event queue");
		const q = { id: String(answer.queue_id), last: Number(answer.last_event_id ?? -1) };
		source.kv.set(QUEUE, q);
		return q;
	};

	const held = hold(source, {
		host: site.hostname,
		run: async (signal, up) => {
			me = String((await api("GET", "/users/me", signal)).user_id ?? "");
			if (!me) throw new Plain("Zulip did not say which bot this is");
			let q = source.kv.get<{ id: string; last: number }>(QUEUE) ?? (await register(signal));
			// The queue is live now, even while the first long-poll waits for something to arrive.
			up();
			for (;;) {
				let answer: any;
				try {
					const params = new URLSearchParams({ queue_id: q.id, last_event_id: String(q.last) });
					answer = await api("GET", `/events?${params}`, signal, undefined, POLL + 45_000);
				} catch (e) {
					// An expired queue is not a failure of the source: make a new one and start from now.
					if ((e as any)?.code === "BAD_EVENT_QUEUE_ID") {
						q = await register(signal);
						continue;
					}
					throw e;
				}
				if (signal.aborted) return;
				up();
				for (const event of answer.events ?? []) {
					if (typeof event?.id === "number" && event.id > q.last) {
						q = { ...q, last: event.id };
						source.kv.set(QUEUE, q);
					}
					if (event?.type !== "message") continue;
					const m: any = event.message ?? {};
					const user = String(m.sender_email ?? "");
					if ((user && user === email) || (me && String(m.sender_id) === me) || ignore.includes(user)) continue;
					const kind = m.type === "private" ? "dm" : "stream";
					const stream = kind === "stream" ? String(m.display_recipient ?? "") : "";
					if (kind === "stream" && streams.length && !streams.includes(stream)) continue;
					const topic = String(m.topic ?? m.subject ?? "");
					const text = clip(String(m.content ?? ""));
					// Zulip puts flags on the event itself, alongside message, not inside message.
					const flags = Array.isArray(event.flags) ? event.flags : Array.isArray(m.flags) ? m.flags : [];
					// "mentioned" is the bot by name or a group it is in; @all and its kind do not name the bot.
					const mentioned = flags.includes("mentioned");
					const keyword = keywordIn(keywords, text);
					// With both filters, either is enough (as with the other IM sources).
					if (mentionsOnly || keywords.length) {
						if (!(mentionsOnly && mentioned) && !keyword) continue;
					}
					if (!cap.ok()) continue;
					const dropped = cap.dropped();
					source.emit("message", {
						text,
						user,
						name: clip(String(m.sender_full_name ?? user), 80),
						stream: clip(stream, 80),
						topic: clip(topic, 80),
						kind,
						id: String(m.id ?? ""),
						...(mentioned ? { mention: true } : {}),
						...(keyword ? { keyword } : {}),
						...(dropped ? { dropped } : {}),
					});
				}
			}
		},
	});

	// Sending: only to the channels the owner put on the list, whatever the call names.
	source.onSend(async (message) => {
		if (!sendTo.length) throw new Error('this source was set up to listen only: it has no channels to send to. Tell your owner; they can set it up again with "sendTo"');
		const stream = String(message.stream ?? (sendTo.length === 1 ? sendTo[0] : ""));
		if (!stream) throw new Error(`say which channel: {"stream": "...", "topic": "...", "text": "..."}. It may write to ${sendTo.join(", ")}`);
		if (!sendTo.includes(stream)) throw new Error(`"${stream}" is not a channel this source may send to (${sendTo.join(", ")})`);
		const text = String(message.text ?? "").trim();
		if (!text) throw new Error('there is nothing to send: give "text"');
		const body = new URLSearchParams({ type: "stream", to: stream, topic: String(message.topic ?? "pine"), content: text.slice(0, 30_000) });
		await api("POST", "/messages", held.signal, body);
		return `sent to the Zulip channel ${stream}`;
	});
}
