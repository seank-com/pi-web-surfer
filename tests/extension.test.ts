import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(root, "node_modules/@earendil-works/pi-coding-agent");

test("the source entry loads through the selected real Pi loader", async () => {
	const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href);
	const { createEventBus } = await import(pathToFileURL(join(host, "dist/core/event-bus.js")).href);
	clearExtensionCache();
	const loaded = await loadExtensions([join(root, "src/index.ts")], root, createEventBus());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
});
