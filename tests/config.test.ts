import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BODY_BYTES_CEILING,
	CHUNK_BYTES_CEILING,
	CONFIG_SCHEMA_VERSION,
	DEFAULT_CONFIG,
	findDuplicateKeys,
	loadConfig,
	writeConfigFixture,
} from "../src/config.ts";

function project(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "ws-cfg-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("missing config uses defaults", () => {
	const { dir, cleanup } = project();
	try {
		const result = loadConfig(dir);
		assert.equal(result.invalid, undefined);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
	} finally {
		cleanup();
	}
});

test("valid config overrides defaults", () => {
	const { dir, cleanup } = project();
	try {
		writeConfigFixture(dir, {
			schemaVersion: CONFIG_SCHEMA_VERSION,
			search: { backend: "duckduckgo", maxResults: 5, timeoutMs: 15000 },
			fetch: { privateNetworks: "deny", maxRedirects: 3 },
		});
		const result = loadConfig(dir);
		assert.equal(result.invalid, undefined);
		assert.equal(result.config!.search.backend, "duckduckgo");
		assert.equal(result.config!.search.maxResults, 5);
		assert.equal(result.config!.search.timeoutMs, 15000);
		assert.equal(result.config!.fetch.privateNetworks, "deny");
		assert.equal(result.config!.fetch.maxRedirects, 3);
		// Unspecified values keep defaults.
		assert.equal(result.config!.fetch.maxBodyBytes, DEFAULT_CONFIG.fetch.maxBodyBytes);
	} finally {
		cleanup();
	}
});

test("unknown root and section keys are invalid, not ignored", () => {
	const { dir, cleanup } = project();
	try {
		writeConfigFixture(dir, { schemaVersion: CONFIG_SCHEMA_VERSION, bogus: true });
		assert.match(loadConfig(dir).invalid ?? "", /unknown config keys/);
		writeConfigFixture(dir, { fetch: { bogus: 1 } });
		assert.match(loadConfig(dir).invalid ?? "", /fetch: unknown keys/);
		writeConfigFixture(dir, { search: { bogus: 1 } });
		assert.match(loadConfig(dir).invalid ?? "", /search: unknown keys/);
	} finally {
		cleanup();
	}
});

test("duplicate keys are invalid", () => {
	assert.equal(findDuplicateKeys('{"a":1,"a":2}'), "a");
	assert.equal(findDuplicateKeys('{"a":{"x":1},"b":{"x":2}}'), null); // same key in different objects is fine
	assert.equal(findDuplicateKeys('{"a":1,"b":[{"z":1},{"z":2}]}'), null);
	assert.equal(findDuplicateKeys('{"a":{"k":{"n":1,"n":2}}}'), "n");
	assert.equal(findDuplicateKeys('{"str":"{dup}"}'), null); // braces inside strings ignored
	const { dir, cleanup } = project();
	try {
		const cfgDir = path.join(dir, ".pi", "web-surfer");
		mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(cfgDir, "config.json"), '{"fetch":{"timeoutMs":1,"timeoutMs":2}}', { mode: 0o600 });
		assert.match(loadConfig(dir).invalid ?? "", /duplicate key/);
	} finally {
		cleanup();
	}
});

test("out-of-range values are invalid", () => {
	const { dir, cleanup } = project();
	try {
		writeConfigFixture(dir, { fetch: { maxBodyBytes: BODY_BYTES_CEILING + 1 } });
		assert.match(loadConfig(dir).invalid ?? "", /maxBodyBytes/);
		writeConfigFixture(dir, { fetch: { chunkBytes: CHUNK_BYTES_CEILING + 1 } });
		assert.match(loadConfig(dir).invalid ?? "", /chunkBytes/);
		writeConfigFixture(dir, { search: { maxResults: 11 } });
		assert.match(loadConfig(dir).invalid ?? "", /maxResults/);
		writeConfigFixture(dir, { fetch: { maxRedirects: -1 } });
		assert.match(loadConfig(dir).invalid ?? "", /maxRedirects/);
		writeConfigFixture(dir, { fetch: { timeoutMs: -5 } });
		assert.match(loadConfig(dir).invalid ?? "", /timeoutMs/);
		writeConfigFixture(dir, { search: { backend: "bing" } });
		assert.match(loadConfig(dir).invalid ?? "", /backend/);
		writeConfigFixture(dir, { fetch: { privateNetworks: "sometimes" } });
		assert.match(loadConfig(dir).invalid ?? "", /privateNetworks/);
	} finally {
		cleanup();
	}
});

test("non-JSON and non-object docs are invalid", () => {
	const { dir, cleanup } = project();
	try {
		writeConfigFixture(dir, {});
		const dirCfg = path.join(dir, ".pi", "web-surfer");
		writeFileSync(path.join(dirCfg, "config.json"), "not json");
		assert.match(loadConfig(dir).invalid ?? "", /not valid JSON/);
		writeFileSync(path.join(dirCfg, "config.json"), "[1,2]");
		assert.match(loadConfig(dir).invalid ?? "", /must be a JSON object/);
		writeFileSync(path.join(dirCfg, "config.json"), JSON.stringify({ schemaVersion: 99 }));
		assert.match(loadConfig(dir).invalid ?? "", /schemaVersion/);
	} finally {
		cleanup();
	}
});

test("symlinked config is rejected (unsafe file type)", () => {
	const { dir, cleanup } = project();
	try {
		const outside = mkdtempSync(path.join(tmpdir(), "ws-cfg-out-"));
		writeFileSync(path.join(outside, "config.json"), "{}", { mode: 0o600 });
		const cfgDir = path.join(dir, ".pi", "web-surfer");
		mkdirSync(path.dirname(cfgDir), { recursive: true });
		mkdirSync(cfgDir, { mode: 0o700 });
		// Replace the config file with a symlink.
		symlinkSync(path.join(outside, "config.json"), path.join(cfgDir, "config.json"));
		assert.match(loadConfig(dir).invalid ?? "", /must not be a symlink/);
		rmSync(outside, { recursive: true, force: true });
	} finally {
		cleanup();
	}
});

test("wrong config file mode is invalid", () => {
	const { dir, cleanup } = project();
	try {
		writeConfigFixture(dir, {});
		const file = path.join(dir, ".pi", "web-surfer", "config.json");
		chmodSync(file, 0o644);
		assert.match(loadConfig(dir).invalid ?? "", /expected mode/);
	} finally {
		cleanup();
	}
});
