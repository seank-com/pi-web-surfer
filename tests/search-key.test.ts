import assert from "node:assert/strict";
import test from "node:test";
import { DefaultSearcher, DuckDuckGoAdapter, GeminiAdapter } from "../src/search.ts";

function preserveEnvironment(t: { after(fn: () => void): void }) {
	const names = ["GEMINI_API_KEY", "GEMINI_SEARCH_API_KEY"] as const;
	const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
	t.after(() => { for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; } });
}

test("Gemini search uses only the search-specific key even when a model key also exists", async t => {
	preserveEnvironment(t);
	process.env.GEMINI_API_KEY = "synthetic-model-key";
	process.env.GEMINI_SEARCH_API_KEY = "synthetic-search-key";
	let calls = 0;
	const gemini = new GeminiAdapter({ fetchImpl: async (_url, init) => {
		calls++; assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "synthetic-search-key");
		return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Synthetic answer" }] } }] }));
	} });
	assert.equal(gemini.apiKey, "synthetic-search-key");
	const result = await gemini.search("synthetic query", { maxResults: 1 });
	assert.equal(result.ok, true); assert.equal(calls, 1);
});

test("the native model key alone does not enable Gemini search or prevent explicit keyless fallback", async t => {
	preserveEnvironment(t);
	process.env.GEMINI_API_KEY = "synthetic-model-key";
	delete process.env.GEMINI_SEARCH_API_KEY;
	let geminiCalls = 0, duckCalls = 0;
	const gemini = new GeminiAdapter({ fetchImpl: async () => { geminiCalls++; throw new Error("No Gemini request expected"); } });
	assert.equal(gemini.apiKey, undefined);
	const explicit = await gemini.search("synthetic query", { maxResults: 1 });
	assert.equal(explicit.ok, false); assert.equal(explicit.failure?.code, "key_unavailable");
	assert.match(explicit.failure!.message, /GEMINI_SEARCH_API_KEY/);
	const searcher = new DefaultSearcher(gemini, new DuckDuckGoAdapter({ fetchImpl: async () => {
		duckCalls++; return new Response('<a class="result__a" href="https://example.invalid/">Synthetic source</a>');
	} }));
	const result = await searcher.search("synthetic query", { backend: "auto", maxResults: 1 });
	assert.equal(result.details.backend, "duckduckgo");
	assert.equal(geminiCalls, 0); assert.equal(duckCalls, 1); assert.match(result.text, /Gemini key is not configured/);
});
