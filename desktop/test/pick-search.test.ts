// What a picker (the model of a conversation, an agent, a folder) lists for what was typed, without a window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { narrow } from "../src/text.ts";

const labels = (query: string, items: Array<{ label: string; about?: string }>) => narrow(query, items).map((i) => i.label);

test("a model that does not fit what was typed is left out", () => {
	const models = ["dev/claude-haiku", "openrouter/deepseek-v4", "fireworks/accounts/fireworks/routers/deepseek-r2", "dev/qwen3-coder"].map((m) => ({ value: m, label: m }));
	assert.deepEqual(labels("deep", models), ["openrouter/deepseek-v4", "fireworks/accounts/fireworks/routers/deepseek-r2"]);
	assert.deepEqual(labels("zzz", models), []);
	assert.equal(labels("", models).length, 4, "nothing typed lists them all");
});

test("a line beside an item counts after the labels, and only where it fits", () => {
	const agents = [
		{ label: "scout", about: "the agent that reads the news" },
		{ label: "newsroom", about: "the agent newsroom" },
		{ label: "books", about: "the agent books" },
	];
	assert.deepEqual(labels("news", agents), ["newsroom", "scout"]);
	assert.deepEqual(labels("mail", agents), []);
});
