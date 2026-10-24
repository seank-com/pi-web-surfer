import assert from "node:assert/strict";
import test, { after } from "node:test";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DEFAULT_CONFIG, writeConfigFixture, loadConfig } from "../src/config.ts";
import { executeFetch } from "../src/fetchcore.ts";
import { KeyLock } from "../src/artifacts.ts";
import { httpFetch, isPrivateAddress } from "../src/transport.ts";
import { DefaultSearcher, GeminiAdapter, DuckDuckGoAdapter } from "../src/search.ts";
import { resolveTopLevelTemplate } from "../src/templates.ts";
import { htmlToMarkdown } from "../src/extract.ts";
import { createSessionState, registerWebSurferSession, registerWebSurferTools } from "../src/tools.ts";
const root = await realpath(await mkdtemp(join(tmpdir(), "web-corrections-")));
process.env.TMPDIR = join(root, "tmp");
await mkdir(process.env.TMPDIR, { mode: 0o700 });
after(() => rm(root, { recursive: true, force: true }));
async function fixture(t: test.TestContext) {
	const cwd = await mkdtemp(join(root, "project-"));
	let requests = 0;
	const seen: any[] = [];
	const server = http.createServer((req, res) => {
		requests++;
		const url = new URL(req.url!, "http://fixture.invalid");
		if (url.pathname === "/gzip") {
			const body = gzipSync(Buffer.alloc(2 * 1048576, 97));
			res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": body.length });
			res.end(body);
			return;
		}
		if (url.pathname === "/redirect") {
			res.writeHead(303, { location: "/echo" });
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const observation = {
				method: req.method,
				body: Buffer.concat(chunks).toString(),
				header: req.headers["x-fixture"],
			};
			seen.push(observation);
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(url.pathname === "/ack" ? "ok" : JSON.stringify(observation));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	return {
		cwd,
		url: `http://127.0.0.1:${(server.address() as any).port}`,
		seen,
		count: () => requests,
		env: {
			cwd,
			config: { config: structuredClone(DEFAULT_CONFIG) },
			boundary: { available: true, roots: [] as string[] },
			lock: new KeyLock(),
		},
	};
}

test("identical injected requests execute again while artifact paging remains independent", async (t) => {
	const f = await fixture(t);
	for (const method of ["POST", "PUT"]) {
		const input = { url: f.url + "/echo", method, body: "same", headers: { "x-fixture": "same" } };
		const a = await executeFetch(input, f.env);
		const b = await executeFetch(input, f.env);
		assert.notEqual(a.details.artifactId, b.details.artifactId);
		const before = f.count();
		await executeFetch({ artifactId: a.details.artifactId }, f.env);
		assert.equal(f.count(), before);
	}
	assert.equal(f.count(), 4);
});
test("default UTF-8 boundary preserves all characters and valid continuation", async (t) => {
	const f = await fixture(t);
	const content = "a".repeat(51199) + "\u00e9" + "z";
	const file = join(f.cwd, "text.txt");
	await writeFile(file, content);
	const a = await executeFetch({ filePath: file }, f.env);
	assert.equal(a.details.returnedBytes, 51199);
	assert.doesNotMatch(a.content[0]!.text, /\ufffd/);
	const b = await executeFetch({ artifactId: a.details.artifactId, offset: a.details.nextOffset }, f.env);
	assert.equal(b.details.ok, true);
	assert.equal(b.details.returnedBytes, 3);
	assert.match(b.content[0]!.text, /\u00e9z/);
	const tiny = await executeFetch({ artifactId: a.details.artifactId, offset: 51199, chunkBytes: 1 }, f.env);
	assert.equal(tiny.details.code, "invalid_input");
});
test("paging ceilings and refresh offset restrictions apply consistently", async (t) => {
	const f = await fixture(t);
	const file = join(f.cwd, "text.txt");
	await writeFile(file, "abc");
	const a = await executeFetch({ filePath: file }, f.env);
	for (const chunkBytes of [300000, 0, -1])
		assert.equal(
			(await executeFetch({ artifactId: a.details.artifactId, chunkBytes }, f.env)).details.code,
			"invalid_input",
		);
	assert.equal((await executeFetch({ filePath: file, refresh: true, offset: 1 }, f.env)).details.code, "invalid_input");
});
test("cached URL reuse and artifact paging honor a changed deny policy", async (t) => {
	const f = await fixture(t);
	const a = await executeFetch({ url: f.url }, f.env);
	f.env.config.config.fetch.privateNetworks = "deny";
	for (const input of [{ url: f.url }, { artifactId: a.details.artifactId }])
		assert.equal((await executeFetch(input, f.env)).details.code, "blocked_origin");
	assert.equal(f.count(), 1);
});
test("one-MiB decoded cap fails without publishing a truncated artifact", async (t) => {
	const f = await fixture(t);
	assert.equal(f.env.config.config.fetch.maxBodyBytes, 1048576);
	const result = await executeFetch({ url: f.url + "/gzip" }, f.env);
	assert.equal(result.details.code, "size_exceeded");
	assert.equal(result.details.artifactId, undefined);
});
test("same-origin 303 preserves method body and headers", async (t) => {
	const f = await fixture(t);
	const result = await executeFetch(
		{ url: f.url + "/redirect", method: "POST", body: "payload", headers: { "x-fixture": "retained" } },
		f.env,
	);
	assert.equal(result.details.ok, true);
	assert.deepEqual(f.seen, [{ method: "POST", body: "payload", header: "retained" }]);
});
test("deny lookup is used by the actual connector and cannot publish a private connection", async (t) => {
	const f = await fixture(t);
	let lookups = 0;
	await assert.rejects(
		httpFetch({
			url: f.url.replace("127.0.0.1", "lookup.example"),
			config: { ...DEFAULT_CONFIG.fetch, privateNetworks: "deny" },
			lookupImpl: async () => {
				lookups++;
				return ["127.0.0.1"];
			},
		}),
		(error: any) => error.code === "blocked_origin",
	);
	assert.equal(lookups, 1);
	assert.equal(f.count(), 0);
});
test("deny rejects a redirect into a private literal before the next fetch", async () => {
	let calls = 0;
	await assert.rejects(
		httpFetch({
			url: "https://public.example/start",
			config: { ...DEFAULT_CONFIG.fetch, privateNetworks: "deny" },
			fetchImpl: async (_url, init) => {
				calls++;
				assert.equal(init?.redirect, "manual");
				assert.ok((init as any).dispatcher);
				return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
			},
		}),
		(error: any) => error.code === "blocked_origin",
	);
	assert.equal(calls, 1);
});
test("redirected hostnames use the same checked connector lookup", async (t) => {
	const f = await fixture(t);
	let calls = 0,
		lookups = 0;
	await assert.rejects(
		httpFetch({
			url: "https://public.example/start",
			config: { ...DEFAULT_CONFIG.fetch, privateNetworks: "deny" },
			lookupImpl: async () => {
				lookups++;
				return ["127.0.0.1"];
			},
			fetchImpl: async (url, init) => {
				if (++calls === 1)
					return new Response(null, {
						status: 302,
						headers: { location: f.url.replace("127.0.0.1", "private.example") },
					});
				return fetch(url, init);
			},
		}),
		(error: any) => error.code === "blocked_origin",
	);
	assert.equal(calls, 2);
	assert.equal(lookups, 1);
	assert.equal(f.count(), 0);
});

test("literal and ordinary private address classification covers IPv4 and IPv6", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.1.1",
		"::1",
		"fc00::1",
		"fe90::1",
		"::ffff:127.0.0.1",
	])
		assert.equal(isPrivateAddress(address), true, address);
	for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
});
test("cache preflight and publication both check ownership without creating ready evidence", async (t) => {
	const f = await fixture(t);
	let checks = 0;
	const boundary = {
		available: true,
		roots: [],
		validate: async () => {
			if (++checks >= 3) throw new Error("fixture policy changed");
		},
	};
	const file = join(f.cwd, "source.txt");
	await writeFile(file, "source");
	const result = await executeFetch({ filePath: file }, { ...f.env, boundary });
	assert.equal(result.details.code, "destination_blocked");
	assert.equal(result.details.artifactId, undefined);
	assert.equal(checks, 3);
});
test("save rechecks policy immediately before the exclusive write and preserves its artifact", async (t) => {
	const f = await fixture(t);
	let checks = 0;
	const dest = join(f.cwd, "out.txt");
	const boundary = {
		available: true,
		roots: [],
		validate: async (p: string) => {
			if (p === dest && ++checks === 2) throw new Error("fixture owned now");
		},
	};
	const file = join(f.cwd, "source.txt");
	await writeFile(file, "source");
	const result = await executeFetch({ filePath: file, saveTo: "out.txt" }, { ...f.env, boundary });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.savedPath, undefined);
	assert.ok(result.details.warnings?.some((w) => w.code === "destination_blocked"));
	assert.equal((await executeFetch({ artifactId: result.details.artifactId }, f.env)).details.ok, true);
	await assert.rejects(readFile(dest));
});
test("escaped JSON variables expand normally without naive-map warning", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.cwd, "template.txt"), "Value: {{value}}");
	const result = resolveTopLevelTemplate(
		"{{template:template.txt," + JSON.stringify({ value: 'first\nsecond "quoted"' }) + "}}",
		{},
		{ cwd: f.cwd },
	);
	assert.equal(result.value, 'Value: first\nsecond "quoted"');
	assert.equal(result.warnings.length, 0);
});
test("internal bodies, splices and templates do not inherit the response cap", async (t) => {
	const f = await fixture(t);
	const large = "a".repeat(1048577);
	await writeFile(join(f.cwd, "large.txt"), large);
	await writeFile(join(f.cwd, "template.txt"), "{{value}}");
	const bodies = [
		large,
		"{{file:large.txt}}",
		"{{template:template.txt," + JSON.stringify({ value: large }) + "}}",
	];
	for (const body of bodies) {
		const result = await executeFetch({ url: f.url + "/ack", method: "POST", body, maxBodyBytes: 64 }, f.env);
		assert.equal(result.details.ok, true);
		assert.equal(f.seen.at(-1).body, large);
	}
});
test("environment expansion and headers are independent of the response cap", async (t) => {
	const f = await fixture(t);
	const name = "WEB_SURFER_INTERNAL_PAYLOAD_FIXTURE";
	const old = process.env[name];
	const value = "x".repeat(100);
	process.env[name] = value;
	t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
	const result = await executeFetch({
		url: f.url + "/ack", method: "POST", body: `{{env:${name}}}{{`,
		headers: { "x-fixture": `{{env:${name}}}` }, maxBodyBytes: 64,
	}, f.env);
	assert.equal(result.details.ok, true);
	assert.equal(f.seen[0].body, value + "{{");
	assert.equal(f.seen[0].header, value);
});
test("internal local-file reads are uncapped while pages remain bounded", async (t) => {
	const f = await fixture(t);
	const large = "a".repeat(1048577);
	const file = join(f.cwd, "large.txt");
	await writeFile(file, large);
	const result = await executeFetch({ filePath: file, maxBodyBytes: 1, saveTo: "copy.txt" }, f.env);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.sizeBytes, Buffer.byteLength(large));
	assert.equal(result.details.returnedBytes, DEFAULT_CONFIG.fetch.chunkBytes);
	assert.equal(await readFile(join(f.cwd, "copy.txt"), "utf8"), large);
	assert.equal(f.count(), 0);
});
test("unterminated placeholders preserve literal prefixes exactly once", () => {
	for (const text of ["{{unfinished", "prefix {{unfinished", "before {{unknown}} after {{unfinished"])
		assert.equal(resolveTopLevelTemplate(text, {}).value, text);
	assert.equal(resolveTopLevelTemplate("{{env:VALUE}} prefix {{unfinished", { VALUE: "expanded" }).value,
		"expanded prefix {{unfinished");
});
test("tables retain content beyond the old 2000-character cut", () => {
	assert.ok(htmlToMarkdown("<table><tr><td>" + "a".repeat(2100) + "TAIL</td></tr></table>").includes("TAIL"));
});
test("malformed URL is a controlled failure", async (t) => {
	const f = await fixture(t);
	assert.equal((await executeFetch({ url: "not a URL" }, f.env)).details.code, "malformed_url");
});
test("invalid escaped configuration replaces old authority with an invalid state", async (t) => {
	const f = await fixture(t);
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const state = { current: await createSessionState({ cwd: f.cwd }) };
	const old = state.current;
	const pi: any = {
		on: (n: string, h: any) => handlers.set(n, h),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	};
	registerWebSurferSession(pi, state);
	registerWebSurferTools(pi, () => state.current);
	writeConfigFixture(f.cwd, {});
	await writeFile(join(f.cwd, ".pi/web-surfer/config.json"), '{"\\x":1}');
	await handlers.get("session_start")({}, { cwd: f.cwd });
	assert.notEqual(state.current, old);
	assert.equal(old.controller.signal.aborted, true);
	const result = await tools.get("web_fetch").execute("invalid", { url: f.url }, undefined, undefined, { cwd: f.cwd });
	assert.equal(result.details.code, "config_invalid");
	assert.equal(f.count(), 0);
});
test("no custom timeout configuration remains", async (t) => {
	const f = await fixture(t);
	assert.equal("timeoutMs" in DEFAULT_CONFIG.fetch, false);
	assert.equal("connectTimeoutMs" in DEFAULT_CONFIG.fetch, false);
	assert.equal("timeoutMs" in DEFAULT_CONFIG.search, false);
	writeConfigFixture(f.cwd, { fetch: { timeoutMs: 100 } });
	assert.match(loadConfig(f.cwd).invalid!, /unknown/);
});
for (const response of [
	() => new Response("null"),
	() => new Response("", { status: 500 }),
	() => new Response("", { status: 403 }),
])
	test("a Gemini key keeps provider failures on Gemini without DuckDuckGo fallback", async () => {
		let calls = 0;
		const gemini = new GeminiAdapter({ apiKey: "synthetic-only", fetchImpl: async () => response() });
		const duck = new DuckDuckGoAdapter({
			fetchImpl: async () => {
				calls++;
				throw new Error("must not run");
			},
		});
		const result = await new DefaultSearcher(gemini, duck).search("query", { backend: "auto", maxResults: 10 });
		assert.equal(result.details.ok, false);
		assert.equal(result.details.backend, "gemini");
		assert.equal(calls, 0);
	});
test("Gemini preserves provider-shaped attribution and resolves only the grounding reference", async () => {
	const calls: string[] = [];
	const wrapper = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture";
	const gemini = new GeminiAdapter({
		apiKey: "synthetic-only",
		fetchImpl: async (url, init) => {
			calls.push(String(url));
			if (String(url) === wrapper) {
				assert.equal(init?.redirect, "manual");
				return new Response(null, { status: 302, headers: { location: "https://example.invalid/article" } });
			}
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: { parts: [{ text: "Answer" }] },
							groundingMetadata: {
								groundingChunks: [
									{ web: { uri: wrapper, title: "Source" } },
									{ web: { uri: "https://example.invalid/direct", title: "Direct" } },
								],
							},
						},
					],
				}),
			);
		},
	});
	const result = await gemini.search("query", { maxResults: 10 });
	assert.equal(result.ok, true);
	assert.deepEqual(result.sources, [
		{ title: "Source", url: "https://example.invalid/article" },
		{ title: "Direct", url: "https://example.invalid/direct" },
	]);
	assert.equal(calls.length, 2);
});
test("unresolved grounding references remain visible without fabrication", async () => {
	const wrapper = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture";
	const gemini = new GeminiAdapter({
		apiKey: "synthetic-only",
		fetchImpl: async (url) =>
			String(url) === wrapper
				? new Response("", { status: 500 })
				: new Response(
						JSON.stringify({
							candidates: [
								{
									content: { parts: [{ text: "Answer" }] },
									groundingMetadata: { groundingChunks: [{ web: { uri: wrapper, title: "Source" } }] },
								},
							],
						}),
					),
	});
	const result = await gemini.search("query", { maxResults: 10 });
	assert.equal(result.sources?.[0]?.reference, wrapper);
	assert.ok(result.warnings?.some((w) => w.code === "source_unresolved"));
});
