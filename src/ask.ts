// A route's "ask": typed questions about an event, answered by a decision model (src/decisions.ts) with
// values a filter reads as they are.
//
// The questions are the owner's own text, fixed in the configuration: nothing of the event goes into
// them. What the event carries is the data the questions are about. What the decision model answers is held to the question's type: a probability of yes,
// one of the owner's option names, one of the owner's levels. An answer that is anything else is no
// answer, and nothing is published. So no text of the event passes through the answers, and what is
// published keeps the event's trust (docs/adr/0006-typed-questions.md).

export const ASK_TYPES = ["yesno", "choice", "score"] as const;
export type AskType = (typeof ASK_TYPES)[number];

export interface AskQuestion {
	type: AskType;
	/** The question, in the owner's words: "Does this need an answer today?" */
	question: string;
	/** choice: the options by name, each with when it applies. */
	options?: Record<string, string>;
	/** score: the levels, lowest first. */
	levels?: string[];
}

export type AskQuestions = Record<string, AskQuestion>;

/**
 * yesno: { yes: 0.82 }; choice: { choice: "invoice" }; score: { level: "Today", score: 2 } (0 is the lowest
 * level). A decision model of a service may give a score between levels (1.7: `level` is the nearest one)
 * and, for a choice or a score, how sure it is (`confidence`, 0 to 1).
 */
export type AskAnswer = { yes: number } | { choice: string; confidence?: number } | { level: string; score: number; confidence?: number };
export type AskAnswers = Record<string, AskAnswer>;

/** What a route's "ask" is in pine.json. */
export interface AskConfig {
	questions: AskQuestions;
	/** The decision model that answers, by its name (pine.json's decisions). */
	model: string;
	/** What the questions are about, as a template. Default: the event's payload. */
	data?: unknown;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TEMPLATE = /\{\{/;

/** What is wrong with a route's "ask", in words that say what to write instead. Nothing: it is fine. */
export function askProblem(ask: unknown): string | undefined {
	if (!ask || typeof ask !== "object" || Array.isArray(ask)) return 'ask is an object: {"questions": {...}}';
	const a = ask as Record<string, unknown>;
	if (a.source !== undefined) return 'ask.source is gone: a decision model is named in ask.model now ({"model": "decider"}), and kept under "decisions"';
	if (typeof a.model !== "string" || !a.model) return 'ask needs "model": the decision model that answers, by its name (Settings > Models, Decision models): {"model": "decider", "questions": {...}}';
	return questionsProblem(a.questions);
}

export function questionsProblem(questions: unknown): string | undefined {
	if (!questions || typeof questions !== "object" || Array.isArray(questions)) return 'the questions are an object, each under a name of your own: {"urgent": {"type": "yesno", "question": "Does this need an answer today?"}}';
	const entries = Object.entries(questions as Record<string, any>);
	if (!entries.length) return "at least one question is needed";
	if (entries.length > 16) return "16 questions at most";
	for (const [name, q] of entries) {
		if (!NAME.test(name)) return `"${name}" is not a usable name for a question: letters, digits, - and _, starting with a letter (a filter reads the answer by it: payload.answers.${"<name>"})`;
		if (!q || typeof q !== "object" || Array.isArray(q)) return `the question "${name}" is an object with a "type" and a "question"`;
		if (!ASK_TYPES.includes(q.type)) return `the question "${name}" needs a "type": yesno (answered with the probability of yes), choice (one of named options) or score (one of levels, lowest first)`;
		if (typeof q.question !== "string" || !q.question.trim()) return `the question "${name}" needs "question": what is asked, in your words`;
		// The questions are the owner's fixed text: an event that could fill them could steer what is asked.
		const texts = [q.question, ...Object.keys(q.options ?? {}), ...Object.values(q.options ?? {}), ...(Array.isArray(q.levels) ? q.levels : [])];
		if (texts.some((t) => typeof t === "string" && TEMPLATE.test(t))) return `the question "${name}" has a {{...}} in it. Questions are fixed text; what the event carries goes into "data"`;
		if (q.type === "choice") {
			if (!q.options || typeof q.options !== "object" || Array.isArray(q.options) || Object.keys(q.options).length < 2) return `the question "${name}" needs "options": at least two, each with when it applies, for example {"invoice": "A bill to pay", "other": "Anything else"}`;
			for (const [o, when] of Object.entries(q.options)) {
				// An option is what comes back as the answer, so a phrase is fine ("It is certain"); not a template, and not long.
				if (!o.trim() || o.length > 80 || /[\u0000-\u001f]/.test(o)) return `"${o}" is not a usable option of "${name}": a word or a short phrase, at most 80 characters`;
				if (typeof when !== "string") return `the option "${o}" of "${name}" says in words when it applies`;
			}
		} else if (q.options !== undefined) return `"options" belong to a choice; "${name}" is ${q.type}`;
		if (q.type === "score") {
			if (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10 || q.levels.some((l: unknown) => typeof l !== "string" || !l.trim())) return `the question "${name}" needs "levels": two to ten, lowest first, for example ["Can wait", "This week", "Today"]`;
			if (new Set(q.levels).size !== q.levels.length) return `the levels of "${name}" have to differ`;
		} else if (q.levels !== undefined) return `"levels" belong to a score; "${name}" is ${q.type}`;
	}
	return undefined;
}

/**
 * The answers, held to each question's type. Throws when any answer is missing or is anything but
 * a number from 0 to 1, one of the owner's option names, one of the owner's levels. Only what is
 * checked here is kept: nothing else the answerer said goes on.
 */
export function checkAnswers(raw: unknown, questions: AskQuestions): AskAnswers {
	const given = raw;
	if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error("the answer was not one JSON object");
	const out: AskAnswers = {};
	for (const [name, q] of Object.entries(questions)) {
		const a = (given as Record<string, any>)[name];
		const v = a && typeof a === "object" ? a : { yesno: { yes: a }, choice: { choice: a }, score: { level: a } }[q.type];
		if (q.type === "yesno") {
			const yes = typeof v.yes === "number" ? v.yes : typeof v.yes === "boolean" ? Number(v.yes) : NaN;
			if (!(yes >= 0 && yes <= 1)) throw new Error(`"${name}" was not answered with a probability from 0 to 1`);
			out[name] = { yes: Math.round(yes * 1000) / 1000 };
		} else if (q.type === "choice") {
			if (typeof v.choice !== "string" || !Object.hasOwn(q.options!, v.choice)) throw new Error(`"${name}" was not answered with one of its options (${Object.keys(q.options!).join(", ")})`);
			out[name] = { choice: v.choice, ...sure(v) };
		} else {
			// A level by its name, or a score from 0 to the top level, which may lie between two levels.
			const top = q.levels!.length - 1;
			const score = typeof v.level === "string" ? q.levels!.indexOf(v.level) : typeof v.score === "number" ? v.score : NaN;
			if (!(score >= 0 && score <= top)) throw new Error(`"${name}" was not answered with one of its levels (${q.levels!.join(", ")})`);
			out[name] = { level: q.levels![Math.round(score)], score: Math.round(score * 1000) / 1000, ...sure(v) };
		}
	}
	return out;
}

/** How sure the answerer is, where it says so with a number from 0 to 1. Anything else it says about it is dropped. */
const sure = (v: Record<string, unknown>) => (typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1 ? { confidence: Math.round(v.confidence * 1000) / 1000 } : {});

/** The data as text for a model: a string as it is, anything else as JSON. */
export const dataText = (data: unknown): string => (typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2));
