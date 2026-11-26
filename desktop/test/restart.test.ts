// The app's pine ends without the app asking (it crashed, it was killed) and the app starts it
// again: the page loads its tabs anew from that pine, and keeps what the owner had typed in them.
// An app and a home of its own, since the daemon of the other files' window must stay up.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { patient } from "./support/app.ts";
import { daemonGone, ours } from "./support/daemon.ts";
import { home, page, sees, started } from "./support/window.ts";

before(() => started());

/** The port the newest daemon of the test's home said it listens on. */
const portOf = () => [...fs.readFileSync(path.join(home, "data", "pine.log"), "utf8").matchAll(/http listening on 127\.0\.0\.1:(\d+)/g)].at(-1)?.[1];

test("a draft is still in its tab after the app's pine ended and was started again", { skip: process.platform === "win32" && "the daemon is found by its port with lsof" }, async () => {
	const COMPOSER = "[data-slot=composer] textarea";
	await sees(COMPOSER);
	await page.fill(COMPOSER, "half a message, not sent");
	// The composer drawn now is marked: the one drawn after the page loaded its tabs again is another element.
	await page.$eval(COMPOSER, (el: Element) => el.setAttribute("data-before-restart", ""));

	const port = portOf();
	assert.ok(port, "the daemon said where it listens");
	assert.ok(await ours(port, home), "the daemon on that port is the test home's");
	// Found by the port it listens on, which only the test home's daemon has: no other pine on this computer is touched.
	const pid = Number(execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]);
	assert.ok(pid > 0, "the daemon's process was found");
	process.kill(pid, "SIGKILL");
	assert.ok(await daemonGone(port, home), "the daemon ended");

	// The app finds its pine gone and starts it again, and the page loads its tabs anew.
	await page.waitForSelector(`${COMPOSER}:not([data-before-restart])`, { timeout: patient(40_000) });
	const again = portOf();
	assert.notEqual(again, port, "a new daemon was started");
	assert.ok(again && (await ours(again, home)), "the new daemon is the test home's");
	assert.equal(await page.inputValue(COMPOSER), "half a message, not sent");
});
