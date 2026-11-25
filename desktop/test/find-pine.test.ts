// Which pine and which Node the app runs (findPine in electron/service.ts), without a window.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findPine } from "../electron/service.ts";

test("find-pine: the app's pine runs on the app's Node, even when that Node is slow to answer the first time", { skip: process.platform === "win32" ? "the stand-in for the app's Node is a shell script" : false }, async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-find-")));
	const saved = { PINE_CLI: process.env.PINE_CLI, PINE_NODE: process.env.PINE_NODE };
	try {
		// A packed app's Resources: pine, and a Node that answers nothing for longer than any
		// question about its version waits, as macOS holds the first run of a downloaded program
		// while it checks it.
		const resources = path.join(dir, "Resources");
		fs.mkdirSync(path.join(resources, "pine", "bin"), { recursive: true });
		fs.writeFileSync(path.join(resources, "pine", "bin", "pine.js"), "");
		const own = path.join(resources, "node", "bin", "node");
		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(own, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
		delete process.env.PINE_CLI;
		delete process.env.PINE_NODE;
		const started = Date.now();
		// The app's own folder lies outside any checkout, as in a packed app.
		const launch = await findPine(path.join(dir, "app"), resources);
		assert.deepEqual(launch.argv, [own, path.join(resources, "pine", "bin", "pine.js")]);
		assert.equal(launch.from, "the app");
		// The login shell is asked for its environment; the app's Node is not asked anything.
		assert.ok(Date.now() - started < 7000, `findPine took ${Date.now() - started} ms`);
	} finally {
		for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
