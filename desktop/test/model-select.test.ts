// A model's name is longer than a control — `fireworks/accounts/<account>/routers/<model>` against a
// column of 13rem — and a select drew its list as wide as the control, so the name was cut in the
// trigger and in the list, with nothing that gave it whole. Every select of models goes through
// ModelSelect, which keeps the whole name on hover and lets the list wrap it.
//
// The pages are not run here, as in settings-index.test.ts: the places are looked for in their source,
// so that a fifth select of models, or a part of the fix dropped from ModelSelect, fails this test
// instead of quietly bringing the cut back.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const src = path.join(import.meta.dirname, "../src");
const read = (file: string) => fs.readFileSync(path.join(src, file), "utf8");

test("every select of models is a ModelSelect, and a ModelSelect does not cut the name", () => {
	const settings = read("Settings.tsx");
	assert.equal((settings.match(/<Select items=\{modelItems\}/g) ?? []).length, 0, "a model list is handed to a plain Select: its list is drawn as wide as the control, so the name is cut there and in the trigger");
	// The default model (a setting), an agent's model, a new agent's model, and a route's call.
	assert.ok((settings.match(/<ModelSelect\s/g) ?? []).length >= 4, "fewer model selects go through ModelSelect than Settings draws");

	const parts = read("settings-parts.tsx");
	const model = /export function ModelSelect\([\s\S]*?\n}\n/.exec(parts)?.[0];
	assert.ok(model, "ModelSelect is gone from settings-parts.tsx");
	assert.match(model, /title=\{\s*name\s*\}/, "the trigger does not give the whole name on hover");
	assert.match(model, /max-w-\[/, "the list may not be wider than the control, so a long name has nowhere to go");
	assert.match(model, /whitespace-normal/, "a name that does not fit is cut rather than wrapped");
});
