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

export const JEV_TYPES = ["noul", "choice", "score"] as const;

export interface JevQuestion {
	type: (typeof JEV_TYPES)[number];
	instructions?: unknown;
	criteria?: unknown;
}

export type JevAnswers = Record<string, Record<string, unknown>>;

export interface JevAsk {
	model?: string;
	state: unknown;
	questions: Record<string, JevQuestion>;
	signal?: AbortSignal;
}

export function questionsProblem(questions: unknown): string | undefined {
	if (!questions || typeof questions !== "object" || Array.isArray(questions)) return 'the questions are an object, each question under a name of your own: {"urgent": {"type": "noul", "instructions": "Does this need an answer today?"}}';
	const entries = Object.entries(questions as Record<string, any>);
	if (!entries.length) return "at least one question is needed";
	for (const [name, q] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) return `"${name}" is not a usable name for a question: letters, digits, - and _, starting with a letter (a filter reads the answer by it: payload.answers.<name>)`;
		if (!q || typeof q !== "object" || Array.isArray(q)) return `the question "${name}" is an object with a "type"`;
		if (!JEV_TYPES.includes(q.type)) return `the question "${name}" needs a "type": ${JEV_TYPES.join(", ")} (noul: yes or no, answered with the probability of yes)`;
		if (q.type === "noul" && q.instructions === undefined) return `the question "${name}" needs "instructions": the yes/no question, or the statement to judge`;
		if (q.type === "choice" && (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria) || !Object.keys(q.criteria).length)) return `the question "${name}" needs "criteria": the options, each with when it applies, for example {"invoice": "A bill to pay", "other": "Anything else"}`;
		if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) return `the question "${name}" needs "criteria": the levels as a list, lowest first, for example ["Can wait", "This week", "Today"]`;
	}
	return undefined;
}

const NO_KEY = `Jev has no key. Your owner sets one under Settings > Models, or with: pine login ${JEV_PROVIDER}`;

const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
	});

async function refusal(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	let detail: unknown = text;
	try {
		detail = JSON.parse(text).detail ?? text;
	} catch {}
	return truncate(typeof detail === "string" ? detail : JSON.stringify(detail), 300);
}

export async function askJev(jev: JevConfig, ask: JevAsk, maxChars = 20_000): Promise<JevAnswers> {
	if (!jev.key) throw new Error(NO_KEY);
	const state = typeof ask.state === "string" ? truncate(ask.state, maxChars) : ask.state && typeof ask.state === "object" ? ask.state : String(ask.state ?? "");
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
		const answers = ((await res.json()) as any)?.answers;
		if (!answers || typeof answers !== "object") throw new Error("Jev answered without answers");
		return answers as JevAnswers;
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
