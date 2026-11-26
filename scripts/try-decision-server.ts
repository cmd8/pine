// By hand, not a test: a route of a throwaway pine asks a real decision server over TypeSafe's API, and prints
// what was published. The token is read from PINECONE_TOKEN (or TYPESAFE_KEY for TypeSafe itself) and goes only
// into the throwaway home's .env.
//
//   PINECONE_TOKEN=... node scripts/try-decision-server.ts http://pauls-mac-studio.tail784ebe.ts.net:8080 decider
//   TYPESAFE_KEY=... node scripts/try-decision-server.ts
import { harness } from "../test/support/harness.ts";

const [url, model] = process.argv.slice(2);
const key = url ? process.env.PINECONE_TOKEN : process.env.TYPESAFE_KEY;
const questions = {
	urgent: { type: "yesno", question: "Does this need an answer today?" },
	kind: { type: "choice", question: "What is it?", options: { invoice: "a bill to pay", newsletter: "sent to many, nothing to do", other: "anything else" } },
	mood: { type: "score", question: "How upset is the sender?", levels: ["calm", "annoyed", "angry"] },
};
const h = await harness({
	pine: {
		sources: { judge: { type: "typesafe", ...(url ? { url, model, local: true } : {}), ...(key ? { key: "${PINE_SOURCE_JUDGE_KEY}" } : {}) } },
		routes: [{ name: "mail-judge", on: "mail/in", ask: { source: "judge", data: "{{payload.subject}}\n{{payload.text}}", questions }, publish: { topic: "mail/judged" } }],
	},
	files: key ? { ".env": `PINE_SOURCE_JUDGE_KEY=${key}\n` } : {},
	agents: { main: {} },
});
const mails = [
	{ subject: "OVERDUE: invoice 4711", text: "Your payment of 1,240 EUR is three weeks late. Pay today or we hand this to collections." },
	{ subject: "Our autumn newsletter", text: "Ten recipes for pumpkin season, and what our team did this month." },
];
for (const mail of mails) {
	const started = Date.now();
	const done = Promise.race([h.pine.bus.waitFor("mail/judged", () => true, 180_000), h.pine.bus.waitFor("pine/route-failed", () => true, 180_000)]);
	h.pine.bus.publish("mail/in", mail, { source: "try" });
	const e = await done;
	console.log(`${mail.subject} (${Date.now() - started} ms):`, JSON.stringify(e.topic === "mail/judged" ? (e.payload as any).answers : (e.payload as any).error));
}
console.log("source status:", h.pine.sources.list().find((s) => s.name === "judge")?.status);
await h.close();
process.exit(0);
