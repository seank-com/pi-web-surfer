import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(root, "node_modules/@earendil-works/pi-coding-agent");

test("actual tarball installs and loads alone through native ESM and the selected real Pi loader", { timeout: 60_000 }, async t => {
	const consumer = await mkdtemp(join(tmpdir(), "pi-web-surfer-consumer-"));
	t.after(() => rm(consumer, { recursive: true, force: true }));
	const npmEnv = { ...process.env, npm_config_cache: join(consumer, "npm-cache") };
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], { cwd: root, env: npmEnv, encoding: "utf8", timeout: 30_000 }))[0];
	const paths = packed.files.map((file: { path: string }) => file.path);
	assert.ok(paths.includes("dist/index.js"));
	assert.ok(paths.includes("dist/index.d.ts"));
	assert.ok(paths.every((path: string) => /^(dist\/[^/]+\.(js|d\.ts)|docs\/[^/]+\.md|README\.md|LICENSE|package\.json)$/.test(path)), paths.join("\n"));
	await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
	// A lockfile install does not cache the registry metadata needed by a new
	// consumer. Resolve package dependencies with a fresh, disposable cache so
	// this test cannot depend on metadata left by previous local installations.
	execFileSync("npm", ["install", "--cache", join(consumer, "npm-cache"), "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(consumer, packed.filename)], { cwd: consumer, env: npmEnv, stdio: "pipe", timeout: 30_000 });
	const manifest = JSON.parse(await readFile(join(consumer, "node_modules/@seank/pi-web-surfer/package.json"), "utf8"));
	assert.ok(!("@earendil-works/pi-coding-agent" in (manifest.dependencies ?? {})));
	assert.ok(!("typebox" in (manifest.dependencies ?? {})));
	await writeFile(join(consumer, "probe.ts"), `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
assert.equal(existsSync("node_modules/@earendil-works"), false);
assert.equal(existsSync(join("node_modules", "typebox")), false);
assert.equal(existsSync(join("node_modules", "parse5")), true);
const { loadExtensions } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/extensions/loader.js")).href);
const { createEventBus } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/event-bus.js")).href);
const loaded = await loadExtensions([join(process.cwd(), "node_modules/@seank/pi-web-surfer/dist/index.js")], process.cwd(), createEventBus());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["web_fetch", "web_search"]);
for (const event of ["session_start", "session_shutdown"]) {
  assert.ok(loaded.extensions[0].handlers.has(event), event);
}
`);
	execFileSync(process.execPath, [join(consumer, "probe.ts")], {
		cwd: consumer,
		env: { ...process.env, HOME: join(consumer, "home"), PI_CODING_AGENT_DIR: join(consumer, "profile"), TEST_PI_HOST: host },
		stdio: "pipe",
		timeout: 30_000,
	});
});
