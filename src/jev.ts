import type { PineConfig } from "./config.ts";
import { setEnv, unsetEnv } from "./env-file.ts";
import { truncate } from "./util.ts";

export const JEV_KEY = "TYPESAFE_API_KEY";
export const JEV_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
export const JEV_PROVIDER = "typesafe";

export interface JevConfig {
	key?: string;
	model: string;
	baseUrl: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JevType = "noul" | "choice" | "score";

export const JEV_TYPES: JevType[] = ["noul", "choice", "score"];

export type JevCriteria = string[] | { [option: string]: string | null };

export interface JevQuestion {
	type: JevType;
	instructions?: string;
	criteria?: JevCriteria;
}

export type JevQuestions = Record<string, JevQuestion>;

export interface JevAnswer {
	type: JevType;
	noul?: number;
	choice?: string;
	score?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
}

export type JevAnswers = Record<string, JevAnswer>;

export interface JevAsk {
	model?: string;
	state: string | object;
	questions: JevQuestions;
	signal?: AbortSignal;
}

const isRecord = (value: Json | undefined): value is { [key: string]: Json } => typeof value === "object" && value !== null && !Array.isArray(value);

const isJevType = (value: Json | undefined): value is JevType => JEV_TYPES.some((type) => type === value);

function criteriaOf(value: Json | undefined): JevCriteria | undefined {
	if (Array.isArray(value)) return value.map(String);
	if (!isRecord(value)) return undefined;
	return Object.fromEntries(Object.entries(value).map(([option, when]) => [option, when === null ? null : String(when)]));
}

export function readQuestions(raw: Json | undefined): { questions: JevQuestions } | { problem: string } {
	if (!isRecord(raw)) return { problem: 'the questions are an object, each question under a name of your own: {"urgent": {"type": "noul", "instructions": "Does this need an answer today?"}}' };
	const entries = Object.entries(raw);
	if (!entries.length) return { problem: "at least one question is needed" };
	const questions: JevQuestions = {};
	for (const [name, q] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) return { problem: `"${name}" is not a usable name for a question: letters, digits, - and _, starting with a letter (a filter reads the answer by it: payload.answers.<name>)` };
		if (!isRecord(q)) return { problem: `the question "${name}" is an object with a "type"` };
		if (!isJevType(q.type)) return { problem: `the question "${name}" needs a "type": ${JEV_TYPES.join(", ")} (noul: yes or no, answered with the probability of yes)` };
		if (q.type === "noul" && q.instructions === undefined) return { problem: `the question "${name}" needs "instructions": the yes/no question, or the statement to judge` };
		if (q.type === "choice" && (!isRecord(q.criteria) || !Object.keys(q.criteria).length)) return { problem: `the question "${name}" needs "criteria": the options, each with when it applies, for example {"invoice": "A bill to pay", "other": "Anything else"}` };
		if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) return { problem: `the question "${name}" needs "criteria": the levels as a list, lowest first, for example ["Can wait", "This week", "Today"]` };
		const criteria = criteriaOf(q.criteria);
		questions[name] = { type: q.type, ...(q.instructions !== undefined ? { instructions: String(q.instructions) } : {}), ...(criteria ? { criteria } : {}) };
	}
	return { questions };
}

export function renderQuestions(questions: JevQuestions, fill: (text: string) => string): JevQuestions {
	return Object.fromEntries(
		Object.entries(questions).map(([name, q]) => [
			name,
			{
				type: q.type,
				...(q.instructions !== undefined ? { instructions: fill(q.instructions) } : {}),
				...(Array.isArray(q.criteria) ? { criteria: q.criteria.map(fill) } : q.criteria ? { criteria: Object.fromEntries(Object.entries(q.criteria).map(([option, when]) => [option, when === null ? null : fill(when)])) } : {}),
			},
		]),
	);
}

const NO_KEY = `Jev has no key. Your owner sets one under Settings > Models, or with: pine login ${JEV_PROVIDER}`;

const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
	});

async function refusal(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	let detail: Json = text;
	try {
		const parsed: Json = JSON.parse(text);
		if (isRecord(parsed) && parsed.detail !== undefined) detail = parsed.detail;
	} catch {}
	return truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 300);
}

export async function askJev(jev: JevConfig, ask: JevAsk, maxChars = 20_000): Promise<JevAnswers> {
	if (!jev.key) throw new Error(NO_KEY);
	const state = typeof ask.state === "string" ? truncate(ask.state, maxChars) : ask.state;
	const body = JSON.stringify({ model: ask.model ?? jev.model, state, questions: ask.questions });
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${jev.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${jev.key}`, "content-type": "application/json" },
			body,
			signal: ask.signal ? AbortSignal.any([ask.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
		if ((res.status === 429 || res.status === 529) && attempt < 2) {
			await res.body?.cancel().catch(() => {});
			await pause(500 * 3 ** attempt, ask.signal);
			continue;
		}
		if (res.status === 401) throw new Error(`TypeSafe did not accept the key for Jev. Your owner sets a new one under Settings > Models, or with: pine login ${JEV_PROVIDER}`);
		if (!res.ok) throw new Error(`Jev answered ${res.status}: ${await refusal(res)}`);
		const reply: { answers?: JevAnswers } = await res.json();
		if (!reply?.answers || typeof reply.answers !== "object") throw new Error("Jev answered without answers");
		return reply.answers;
	}
}

export async function keyWorks(baseUrl: string, key: string): Promise<boolean> {
	const res = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
	await res.body?.cancel().catch(() => {});
	if (res.status === 401 || res.status === 403) return false;
	if (!res.ok) throw new Error(`TypeSafe answered ${res.status} when asked whether the key is right. Try again in a moment`);
	return true;
}

export const jevRoutes = (cfg: PineConfig): string[] => cfg.routes.filter((r) => r.jev).map((r) => r.name);

export function setJevKey(cfg: PineConfig, key: string): void {
	const value = key.trim();
	if (!value) throw new Error("the key is empty");
	setEnv(cfg.home, { [JEV_KEY]: value });
	cfg.jev.key = value;
	if (value.length >= 8 && !cfg.secrets.includes(value)) cfg.secrets.push(value);
}

export function dropJevKey(cfg: PineConfig): void {
	const users = jevRoutes(cfg);
	if (users.length) throw new Error(`the route${users.length === 1 ? "" : "s"} ${users.join(", ")} ask${users.length === 1 ? "s" : ""} Jev. Remove ${users.length === 1 ? "it" : "them"} first`);
	unsetEnv(cfg.home, [JEV_KEY]);
	cfg.jev.key = undefined;
}
