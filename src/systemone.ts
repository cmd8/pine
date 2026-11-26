import { type Agent, fetch } from "undici";
import type { AskQuestions } from "./ask.ts";

// TypeSafe's System One API (https://docs.typesafe.ai/api/system-one.md), which the `typesafe` type
// speaks to TypeSafe and the `decider` type to a server of the owner's own that answers the same way
// (Pinecone does). Not a source type: what both send and how they read the answer.

/** pine's questions in System One's words: yesno is noul, question is instructions, options and levels are criteria. */
export const fromPine = (questions: AskQuestions) =>
	Object.fromEntries(
		Object.entries(questions).map(([name, q]) => [
			name,
			q.type === "yesno" ? { type: "noul", instructions: q.question } : q.type === "choice" ? { type: "choice", instructions: q.question, criteria: q.options } : { type: "score", instructions: q.question, criteria: q.levels },
		]),
	);

/** The answers in pine's words. What does not fit is left for the router to refuse (src/ask.ts). */
export const toPine = (answers: Record<string, any>, questions: AskQuestions) =>
	Object.fromEntries(
		Object.entries(questions).map(([name, q]) => {
			const a = answers?.[name];
			if (!a || typeof a !== "object") return [name, undefined];
			const confidence = typeof a.confidence === "number" ? { confidence: a.confidence } : {};
			return [name, q.type === "yesno" ? { yes: a.noul } : q.type === "choice" ? { choice: a.choice, ...confidence } : { score: a.score, ...confidence }];
		}),
	);

/**
 * Put the questions to `${url}/v1/systemone`. The key goes to that address and nowhere a redirect says.
 * A busy answer (429, 529) is tried again after each pause of `retries`. Nothing the server writes in an
 * error is repeated: an error says, in pine's words, who answered what status.
 */
export async function systemOne(o: { url: string; key?: string; model: string; questions: AskQuestions; data: unknown; signal: AbortSignal; timeoutMs: number; guard?: Agent; retries: number[]; who: string }): Promise<Record<string, unknown>> {
	const body = JSON.stringify({ model: o.model, state: o.data ?? "", questions: fromPine(o.questions) });
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${o.url}/v1/systemone`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) },
			body,
			redirect: "error",
			signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]),
			...(o.guard ? { dispatcher: o.guard } : {}),
		});
		if ((res.status === 429 || res.status === 529) && attempt < o.retries.length) {
			await res.body?.cancel().catch(() => {});
			await new Promise((r) => setTimeout(r, o.retries[attempt]));
			continue;
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw Object.assign(new Error(refusal(o.who, o.model, res.status)), { status: res.status });
		}
		const answers = ((await res.json().catch(() => undefined)) as any)?.answers;
		if (!answers || typeof answers !== "object") throw new Error(`${o.who} answered without answers`);
		return toPine(answers, o.questions);
	}
}

function refusal(who: string, model: string, status: number): string {
	if (status === 401 || status === 403) return `${who} did not accept the key (${status}). Set the source up again with the right key`;
	if (status === 404) return `${who} does not know the model "${model}" (404). Set the source up again with a model it has`;
	if (status === 413) return `the data is too large for ${who} (413)`;
	if (status === 400 || status === 422) return `${who} refused the request (${status}): the data may be longer than the model reads, or the questions are not what it takes`;
	if (status === 429 || status === 529) return `${who} is busy (${status}), also after waiting`;
	return `${who} answered ${status}`;
}
