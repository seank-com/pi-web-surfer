import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type WebSurferConfig } from "../src/config.ts";
import { KeyLock } from "../src/artifacts.ts";
import { executeFetch, type FetchEnvironment } from "../src/fetchcore.ts";
import { BOUNDARY_REPLY, BOUNDARY_REQUEST, type EventBusLike } from "../src/policy.ts";
import {
	DefaultSearcher,
	DuckDuckGoAdapter,
	FALLBACK_WARNING,
	GeminiAdapter,
} from "../src/search.ts";
import { createSessionState } from "../src/tools.ts";

const PAGE_HTML = `<!doctype html><html><head><title>Test Page</title></head><body>
<h1>Integration Page</h1>
<p>Hello <a href="/link">world</a> from the integration test.</p>
<ul><li>one</li><li>two</li></ul>
</body></html>`;

interface ServerHarness {
	baseUrl: string;
	count: (key: string) => number;
	close: () => Promise<void>;
}

function startServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void,
): Promise<ServerHarness> {
	return new Promise((resolve) => {
		const hits = new Map<string, number>();
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const key = `${req.method} ${url.pathname}`;
			hits.set(key, (hits.get(key) ?? 0) + 1);
			handler(req, res, url);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				count: (key) => hits.get(key) ?? 0,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}

/** Standard fixture routes on 127.0.0.1 (a private address, per the deny policy). */
async function startFixtureServer(crossBaseUrl?: string): Promise<ServerHarness> {
	const bigUnit = "<p>Filler paragraph for paging tests. </p>";
	return startServer((req, res, url) => {
		if (url.pathname === "/page.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE_HTML);
			return;
		}
		if (url.pathname === "/big.html") {
			const n = Math.max(1024, Number(url.searchParams.get("n") ?? 200_000));
			const body =
				"<!doctype html><html><body><h1>Big</h1>" +
				bigUnit.repeat(Math.ceil(n / bigUnit.length)) +
				"</body></html>";
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
			return;
		}
		if (url.pathname === "/text.txt") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("plain line one\nplain line two\n");
			return;
		}
		if (url.pathname === "/binary.bin") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(Buffer.from([0, 1, 2, 0, 255, 0, 65]));
			return;
		}
		if (url.pathname === "/http-error") {
			res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end("boom");
			return;
		}
		if (url.pathname === "/post-echo") {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end(`method=${req.method}\nbody=${body}\nx-secret=${req.headers["x-secret"] ?? "-"}\n`);
			});
			return;
		}
		if (url.pathname === "/redirect-same") {
			res.writeHead(302, { location: "/post-echo" });
			res.end();
			return;
		}
		if (url.pathname === "/redirect-cross" && crossBaseUrl) {
			res.writeHead(302, { location: `${crossBaseUrl}/post-echo` });
			res.end();
			return;
		}
		const chain = /^\/chain\/(\d+)$/.exec(url.pathname);
		if (chain) {
			const n = Number(chain[1]);
			if (n >= 9) {
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end("end");
			} else {
				res.writeHead(302, { location: `/chain/${n + 1}` });
				res.end();
			}
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	});
}

function projectDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "ws-it-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeEnv(dir: string, overrides: Partial<FetchEnvironment> = {}): FetchEnvironment {
	return {
		cwd: dir,
		config: { config: structuredClone(DEFAULT_CONFIG) },
		boundary: { available: true, roots: [] },
		lock: new KeyLock(),
		...overrides,
	};
}

function withConfig(dir: string, config: WebSurferConfig): FetchEnvironment {
	return makeEnv(dir, { config: { config: structuredClone(config) } });
}

test("raw-mode fetch pages from the stored artifact without re-downloading", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const env = makeEnv(dir);

	const first = await executeFetch({ url: `${server.baseUrl}/big.html?n=90000`, mode: "raw" }, env);
	assert.equal(first.details.ok, true);
	const total = first.details.totalTextBytes!;
	assert.ok(total > 51_200 && total < 102_400, `unexpected total ${total}`);
	assert.equal(first.details.returnedBytes, 51_200);
	assert.equal(first.details.endOfFile, undefined);
	assert.ok(first.details.artifactId);

	const second = await executeFetch(
		{ artifactId: first.details.artifactId, offset: first.details.nextOffset, mode: "raw" },
		env,
	);
	assert.equal(second.details.ok, true);
	assert.equal(second.details.artifactId, first.details.artifactId);
	assert.equal(second.details.endOfFile, true);
	assert.equal(second.details.returnedBytes, total - 51_200);
	// Paging is served from the artifact, not the network.
	assert.equal(server.count("GET /big.html"), 1);

	const past = await executeFetch(
		{ artifactId: first.details.artifactId, offset: total + 1, mode: "raw" },
		env,
	);
	assert.equal(past.details.code, "invalid_offset");
});

test("readable mode converts HTML to Markdown with a single network hit", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const result = await executeFetch({ url: `${server.baseUrl}/page.html` }, makeEnv(dir));
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /Integration Page/);
	assert.equal(result.details.binary, undefined);
	assert.equal(server.count("GET /page.html"), 1);
});

test("an identical GET reuses the artifact; refresh forces a new request", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const env = makeEnv(dir);
	const a = await executeFetch({ url: `${server.baseUrl}/page.html` }, env);
	const b = await executeFetch({ url: `${server.baseUrl}/page.html` }, env);
	assert.equal(a.details.artifactId, b.details.artifactId);
	assert.equal(server.count("GET /page.html"), 1);

	const c = await executeFetch({ url: `${server.baseUrl}/page.html`, refresh: true }, env);
	assert.notEqual(c.details.artifactId, a.details.artifactId);
	assert.equal(server.count("GET /page.html"), 2);
});

test("POST with body and headers is distinct from GET and carries the body", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const env = makeEnv(dir);
	const get = await executeFetch({ url: `${server.baseUrl}/post-echo` }, env);
	const post = await executeFetch(
		{
			url: `${server.baseUrl}/post-echo`,
			method: "POST",
			body: "payload-123",
			headers: { "x-secret": "abc" },
		},
		env,
	);
	assert.equal(post.details.ok, true);
	assert.notEqual(post.details.artifactId, get.details.artifactId);
	assert.match(post.content[0].text, /method=POST/);
	assert.match(post.content[0].text, /body=payload-123/);
	assert.match(post.content[0].text, /x-secret=abc/);
	assert.equal(server.count("GET /post-echo"), 1);
	assert.equal(server.count("POST /post-echo"), 1);
});

test("same-origin redirects forward method, body, and headers; cross-origin do not", async (t) => {
	const cross = await startFixtureServer();
	const server = await startFixtureServer(cross.baseUrl);
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		await cross.close();
		cleanup();
	});
	const env = makeEnv(dir);

	const same = await executeFetch(
		{
			url: `${server.baseUrl}/redirect-same`,
			method: "POST",
			body: "keep-me",
			headers: { "x-secret": "abc" },
		},
		env,
	);
	assert.equal(same.details.ok, true);
	assert.equal(same.details.finalUrl, `${server.baseUrl}/post-echo`);
	assert.match(same.content[0].text, /method=POST/);
	assert.match(same.content[0].text, /body=keep-me/);
	assert.match(same.content[0].text, /x-secret=abc/);

	const crossResult = await executeFetch(
		{
			url: `${server.baseUrl}/redirect-cross`,
			method: "POST",
			body: "secret-body",
			headers: { "x-secret": "abc" },
		},
		env,
	);
	assert.equal(crossResult.details.ok, true);
	assert.match(crossResult.content[0].text, /method=GET/);
	assert.match(crossResult.content[0].text, /body=\n/);
	assert.match(crossResult.content[0].text, /x-secret=-/);
	assert.equal(cross.count("GET /post-echo"), 1);
	assert.equal(cross.count("POST /post-echo"), 0);
});

test("the redirect limit is enforced", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const result = await executeFetch({ url: `${server.baseUrl}/chain/1` }, makeEnv(dir));
	assert.equal(result.details.code, "redirect_limit");
});

test("privateNetworks deny blocks loopback in the connection path", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const config = structuredClone(DEFAULT_CONFIG);
	config.fetch.privateNetworks = "deny";
	const result = await executeFetch({ url: `${server.baseUrl}/page.html` }, withConfig(dir, config));
	assert.equal(result.details.code, "blocked_origin");
	assert.equal(server.count("GET /page.html"), 0);
});

test("the per-call maxBodyBytes cap fails fast on a known large body", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const result = await executeFetch(
		{ url: `${server.baseUrl}/big.html?n=200000`, maxBodyBytes: 1024 },
		makeEnv(dir),
	);
	assert.equal(result.details.code, "size_exceeded");
});

test("non-2xx responses retain the body with a disclosed status warning", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const result = await executeFetch({ url: `${server.baseUrl}/http-error` }, makeEnv(dir));
	assert.equal(result.details.ok, true);
	assert.equal(result.details.httpStatus, 500);
	assert.ok(result.details.warnings?.some((w) => w.code === "http_error"));
	assert.match(result.content[0].text, /boom/);
});

test("binary responses are stored as artifacts, not inlined", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const result = await executeFetch({ url: `${server.baseUrl}/binary.bin` }, makeEnv(dir));
	assert.equal(result.details.ok, true);
	assert.equal(result.details.binary, true);
	assert.match(result.content[0].text, /\[binary content/);
});

test("saveTo copies the stored source bytes and never overwrites", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const env = makeEnv(dir);
	const result = await executeFetch({ url: `${server.baseUrl}/page.html`, saveTo: "out/page.html" }, env);
	assert.equal(result.details.ok, true);
	// savedPath is reported project-relative; verify the bytes on disk.
	assert.equal(result.details.savedPath, path.join("out", "page.html"));
	assert.equal(readFileSync(path.join(dir, "out", "page.html"), "utf8"), PAGE_HTML);

	// The artifact is a copy source: it must still serve pages after saving.
	const paged = await executeFetch({ artifactId: result.details.artifactId!, offset: 0 }, env);
	assert.equal(paged.details.ok, true);

	// Saving to an existing destination is refused as a policy block (the
	// content is still served) and never overwrites the existing file.
	const again = await executeFetch({ url: `${server.baseUrl}/page.html`, saveTo: "out/page.html" }, env);
	assert.equal(again.details.ok, true);
	assert.ok(again.details.warnings?.some((w) => w.code === "destination_blocked"));
	assert.equal(readFileSync(path.join(dir, "out", "page.html"), "utf8"), PAGE_HTML);
});

test("saveTo refuses protected, foreign, and unresolvable destinations", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	const store = path.join(dir, "notes");
	mkdirSync(store, { recursive: true });
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const url = `${server.baseUrl}/page.html`;
	// Each refusal keeps the content served (ok) and reports a
	// destination_blocked warning without writing the file.
	const blocked = (details: { ok: boolean; warnings?: { code: string; message: string }[] }) => {
		assert.equal(details.ok, true);
		assert.ok(details.warnings?.some((w) => w.code === "destination_blocked"));
	};

	const intoStore = await executeFetch(
		{ url, saveTo: "notes/stored.html" },
		makeEnv(dir, { boundary: { available: true, roots: [store] } }),
	);
	blocked(intoStore.details);
	assert.equal(existsSync(path.join(dir, "notes", "stored.html")), false);

	const intoConfig = await executeFetch({ url, saveTo: ".pi/web-surfer/inner.txt" }, makeEnv(dir));
	blocked(intoConfig.details);
	assert.equal(existsSync(path.join(dir, ".pi", "web-surfer", "inner.txt")), false);

	const outside = await executeFetch({ url, saveTo: "../outside.html" }, makeEnv(dir));
	blocked(outside.details);
	assert.equal(existsSync(path.resolve(dir, "..", "outside.html")), false);

	const noBoundary = await executeFetch(
		{ url, saveTo: "out/p2.html" },
		makeEnv(dir, { boundary: { available: false, roots: [], reason: "no responder" } }),
	);
	blocked(noBoundary.details);
	assert.equal(existsSync(path.join(dir, "out", "p2.html")), false);
});

test("local path reads extract with no network and report the path", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	writeFileSync(path.join(dir, "local.html"), PAGE_HTML);
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const env = makeEnv(dir);
	const result = await executeFetch({ filePath: "local.html" }, env);
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /Integration Page/);
	assert.equal(result.details.path, path.join(dir, "local.html"));
	assert.equal(server.count("GET /page.html"), 0);
});

test("template injection resolves env and file placeholders into the body", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	const tokenFile = path.join(dir, "token.txt");
	writeFileSync(tokenFile, "file-token");
	process.env.WS_IT_TOKEN = "tok-123";
	t.after(() => {
		delete process.env.WS_IT_TOKEN;
		void server.close();
		cleanup();
	});
	const env = makeEnv(dir);

	const result = await executeFetch(
		{
			url: `${server.baseUrl}/post-echo`,
			method: "POST",
			body: `A={{env:WS_IT_TOKEN}} B={{file:${tokenFile}}}`,
		},
		env,
	);
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /body=A=tok-123 B=file-token/);

	const missing = await executeFetch(
		{ url: `${server.baseUrl}/post-echo`, method: "POST", body: "{{env:WS_IT_UNSET_VAR}}" },
		env,
	);
	assert.equal(missing.details.code, "env_unavailable");

	const a = path.join(dir, "ta.txt");
	const b = path.join(dir, "tb.txt");
	writeFileSync(a, `{{template:${b}}}`);
	writeFileSync(b, `{{template:${a}}}`);
	const cyclic = await executeFetch(
		{ url: `${server.baseUrl}/post-echo`, method: "POST", body: `{{template:${a}}}` },
		env,
	);
	assert.equal(cyclic.details.code, "template_error");
});

test("a pre-aborted signal cancels the operation", async (t) => {
	const server = await startFixtureServer();
	const { dir, cleanup } = projectDir();
	t.after(async () => {
		await server.close();
		cleanup();
	});
	const controller = new AbortController();
	controller.abort();
	const result = await executeFetch(
		{ url: `${server.baseUrl}/page.html` },
		makeEnv(dir, { signal: controller.signal }),
	);
	assert.equal(result.details.code, "cancelled");
});

test("auto search falls back to DuckDuckGo with the loud warning", async (t) => {
	const items = [
		`<a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.com/a")}&rut=x">Example A</a>`,
		`<a class="result__snippet" href="/l/?uddg=${encodeURIComponent("https://example.com/a")}">Snippet A text</a>`,
		`<a class="result__a" href="https://example.org/b">Example B</a>`,
		`<a class="result__snippet" href="https://example.org/b">Snippet B text</a>`,
	].join("");
	const ddgHtml = `<html><body>${items}</body></html>`;
	const fakeFetch = (async () =>
		new Response(ddgHtml, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
	const searcher = new DefaultSearcher(
		new GeminiAdapter(),
		new DuckDuckGoAdapter({ fetchImpl: fakeFetch }),
	);
	const savedKey = process.env.GEMINI_API_KEY;
	delete process.env.GEMINI_API_KEY;
	t.after(() => {
		if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = savedKey;
	});

	const outcome = await searcher.search("test query", {
		backend: "auto",
		maxResults: 10,
		timeoutMs: 5_000,
	});
	assert.equal(outcome.details.ok, true);
	assert.equal(outcome.details.fallback, true);
	assert.equal(outcome.details.backend, "duckduckgo");
	assert.equal(outcome.details.resultCount, 2);
	assert.equal(outcome.details.primaryAvailable, false);
	assert.equal(outcome.details.sources?.[0]?.url, "https://example.com/a");
	assert.equal(outcome.details.sources?.[0]?.title, "Example A");
	assert.equal(outcome.details.sources?.[1]?.url, "https://example.org/b");
	assert.ok(outcome.text.includes(FALLBACK_WARNING));
});

test("session boundary discovery resolves roots, and fails closed when configured but silent", async (t) => {
	const { dir, cleanup } = projectDir();
	t.after(() => cleanup());

	// A responder that reports one root.
	const store = path.join(dir, "notes");
	mkdirSync(store, { recursive: true });
	let replyHandler: ((data: unknown) => void) | undefined;
	const respondingBus: EventBusLike = {
		emit(type, data) {
			if (type === BOUNDARY_REQUEST) {
				const req = data as { requestId: string };
				setImmediate(() =>
					replyHandler?.({ version: 1, requestId: req.requestId, roots: [store] }),
				);
			}
		},
		on(type, handler) {
			if (type === BOUNDARY_REPLY) replyHandler = handler;
			return () => {
				replyHandler = undefined;
			};
		},
	};
	const withResponder = await createSessionState({ cwd: dir, events: respondingBus });
	assert.equal(withResponder.boundary.available, true);
	assert.deepEqual(withResponder.boundary.roots, [path.resolve(store)]);

	// Datastore configured but nobody answers: fail closed.
	mkdirSync(path.join(dir, ".pi", "markdown-datastore"), { recursive: true, mode: 0o700 });
	writeFileSync(
		path.join(dir, ".pi", "markdown-datastore", "config.json"),
		"{}",
		{ mode: 0o600 },
	);
	const silentBus: EventBusLike = { emit: () => {}, on: () => () => {} };
	const failClosed = await createSessionState({ cwd: dir, events: silentBus });
	assert.equal(failClosed.boundary.available, false);

	// No datastore at all: authoritatively empty.
	const clean = projectDir();
	t.after(() => clean.cleanup());
	const noDatastore = await createSessionState({ cwd: clean.dir, events: silentBus });
	assert.equal(noDatastore.boundary.available, true);
	assert.deepEqual(noDatastore.boundary.roots, []);
});
