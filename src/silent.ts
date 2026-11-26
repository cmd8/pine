// An agent that has nothing to say answers exactly NO_REPLY (or SILENT): a routine check that found
// nothing, or a notice of pine's own (a command in the background ended, an MCP server is connected)
// about something it has already reported. Such an answer is sent nowhere and shown nowhere. Pure, with
// no Node in it: the app's page uses it too.

const SILENT = /^\s*(NO_REPLY|SILENT)\s*$/;
const WORDS = ["NO_REPLY", "SILENT"];

/** Whether an answer is the word for "nothing to say". */
export const silent = (text: string | undefined): boolean => !!text && SILENT.test(text);

/** Whether text that is still being written could yet turn out to be that word: it is held back until it cannot. */
export const maybeSilent = (text: string): boolean => {
	const t = text.trim();
	return !t || WORDS.some((w) => w.startsWith(t));
};
