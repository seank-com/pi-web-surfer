import type { SearchConfig } from "./config.ts";
import type { SearchDetails, SearchSource, Warning } from "./types.ts";

/**
 * web_search (D6, D7, D10).
 *
 * Primary: Gemini Google Search grounding (keyed). Keyless fallback:
 * DuckDuckGo HTML. Fallback is visible, never disguised. Provider
 * attribution, order, and content are preserved as returned; the only
 * added treatment is the ungrounded label, visible warnings, and the
 * model-facing output bound.
 */

export const FALLBACK_WARNING =
	"[WARNING: Results from fallback path, inform the user that primary path failed!]";

export const SEARCH_OUTPUT_MAX_BYTES = 51_200;
export const SEARCH_UPSTREAM_MAX_BYTES = 1_048_576;
export const GEMINI_MODEL = "gemini-2.5-flash";

export interface SearchBackendResult {
	ok: boolean;
	backend: string;
	/** Answer text, if the backend produced one. */
	answer?: string;
	sources?: SearchSource[];
	/** True when an answer was produced with no attributed sources. */
	ungrounded?: boolean;
	warnings?: Warning[];
	/** Failure cause for auto-mode fallback decisions. */
	failure?: {
		code: "key_unavailable" | "search_failed";
		message: string;
	};
}

export interface SearchAdapter {
	backend: string;
	search(query: string, opts: SearchOpts): Promise<SearchBackendResult>;
}

export interface SearchOpts {
	maxResults: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** The complete search result as assembled for the model. */
export interface SearchOutcome {
	text: string;
	details: SearchDetails;
}

// ---------------------------------------------------------------------------
// Gemini (keyed primary)
// ---------------------------------------------------------------------------

export interface GeminiAdapterOptions {
	apiKey?: string;
	/** Test seam: endpoint override. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}

export class GeminiAdapter implements SearchAdapter {
	backend = "gemini";
	readonly opts: GeminiAdapterOptions;

	constructor(opts: GeminiAdapterOptions = {}) {
		this.opts = opts;
	}

	get apiKey(): string | undefined {
		return this.opts.apiKey ?? process.env.GEMINI_API_KEY;
	}

	async search(query: string, opts: SearchOpts): Promise<SearchBackendResult> {
		const key = this.apiKey;
		if (!key) {
			return {
				ok: false,
				backend: this.backend,
				failure: { code: "key_unavailable", message: "GEMINI_API_KEY is not available" },
			};
		}
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		const baseUrl = this.opts.baseUrl ?? "https://generativelanguage.googleapis.com";
		const url = `${baseUrl}/v1beta/models/${GEMINI_MODEL}:generateContent`;
		const payload = {
			contents: [
				{
					role: "user",
					parts: [{ text: `Use Google Search grounding to find current information about: ${query}` }],
				},
			],
			tools: [{ google_search: {} }],
		};

		let res: Response;
		try {
			res = await fetchWithBudget(url, {
				method: "POST",
				headers: { "x-goog-api-key": key, "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: opts.signal,
				timeoutMs: opts.timeoutMs,
				maxBytes: SEARCH_UPSTREAM_MAX_BYTES,
				fetchImpl,
			});
		} catch (err) {
			return {
				ok: false,
				backend: this.backend,
				failure: { code: "search_failed", message: geminiFailureMessage(err) },
			};
		}

		if (res.status === 401 || res.status === 403) {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: `gemini auth failed (HTTP ${res.status})` } };
		}
		if (res.status === 429) {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: "gemini quota exhausted (HTTP 429)" } };
		}
		if (!res.ok) {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: `gemini request failed (HTTP ${res.status})` } };
		}

		let doc: unknown;
		try {
			doc = JSON.parse(await res.text());
		} catch {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: "gemini returned a non-JSON response" } };
		}

		const { answer, sources, warnings } = parseGeminiResponse(doc, opts.maxResults);
		if (answer === undefined && (sources?.length ?? 0) === 0) {
			return {
				ok: false,
				backend: this.backend,
				failure: { code: "search_failed", message: "gemini returned neither a usable answer nor sources" },
			};
		}
		return {
			ok: true,
			backend: this.backend,
			answer,
			sources: sources ?? [],
			ungrounded: answer !== undefined && (sources?.length ?? 0) === 0,
			warnings,
		};
	}
}

function parseGeminiResponse(doc: unknown, maxResults: number): {
	answer?: string;
	sources?: SearchSource[];
	warnings?: Warning[];
} {
	const root = doc as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
	};
	const warnings: Warning[] = [];
	const parts = root.candidates?.[0]?.content?.parts ?? [];
	const answerText = parts
		.map((p) => (typeof p?.text === "string" ? p.text : ""))
		.join("")
		.trim();
	const answer = answerText.length > 0 ? answerText : undefined;

	// Sources come from grounding chunks in candidate metadata, preserved in
	// service order with no deduplication or re-ordering (D6).
	const rawSources: unknown[] = [];
	for (const candidate of root.candidates ?? []) {
		const meta = (candidate as { groundingMetadata?: { groundingChunks?: unknown[] } }).groundingMetadata;
		for (const chunk of meta?.groundingChunks ?? []) {
			rawSources.push(chunk);
		}
	}
	const sources: SearchSource[] = [];
	for (const chunk of rawSources) {
		if (sources.length >= maxResults) break;
		const c = chunk as {
			webSearchResult?: { uri?: string; title?: string };
			reference?: string;
		};
		const uri = typeof c?.webSearchResult?.uri === "string" ? c.webSearchResult.uri : undefined;
		const title = typeof c?.webSearchResult?.title === "string" ? c.webSearchResult.title : undefined;
		if (uri && /^https?:\/\//.test(uri)) {
			sources.push({ url: uri, ...(title ? { title } : {}) });
			continue;
		}
		// Unresolved reference: preserve the provider reference verbatim with
		// a visible warning (D7). No fabricated URLs.
		const reference = typeof c?.reference === "string" ? c.reference : JSON.stringify(c ?? {});
		sources.push({ reference, ...(title ? { title } : {}) });
		warnings.push({ code: "source_unresolved", message: `source link could not be resolved; provider reference preserved` });
	}
	return { answer, sources: sources.length > 0 ? sources : undefined, warnings: warnings.length > 0 ? warnings : undefined };
}

function geminiFailureMessage(err: unknown): string {
	if (err && typeof err === "object" && (err as { code?: string }).code === "cancelled") {
		return "cancelled";
	}
	if (err && typeof err === "object" && (err as { code?: string }).code === "timeout") {
		return "gemini request timed out";
	}
	const msg = err instanceof Error ? err.message : String(err);
	return `gemini request failed: ${msg}`;
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML (keyless fallback)
// ---------------------------------------------------------------------------

export interface DuckDuckGoAdapterOptions {
	/** Test seam: endpoint override. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}

export class DuckDuckGoAdapter implements SearchAdapter {
	backend = "duckduckgo";
	readonly opts: DuckDuckGoAdapterOptions;

	constructor(opts: DuckDuckGoAdapterOptions = {}) {
		this.opts = opts;
	}

	async search(query: string, opts: SearchOpts): Promise<SearchBackendResult> {
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		const baseUrl = this.opts.baseUrl ?? "https://html.duckduckgo.com";
		const url = `${baseUrl}/html/?q=${encodeURIComponent(query)}`;
		let res: Response;
		try {
			res = await fetchWithBudget(url, {
				method: "GET",
				headers: {
					"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
					accept: "text/html",
				},
				signal: opts.signal,
				timeoutMs: opts.timeoutMs,
				maxBytes: SEARCH_UPSTREAM_MAX_BYTES,
				fetchImpl,
			});
		} catch (err) {
			return {
				ok: false,
				backend: this.backend,
				failure: { code: "search_failed", message: ddgFailureMessage(err) },
			};
		}
		if (!res.ok) {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: `duckduckgo request failed (HTTP ${res.status})` } };
		}
		const html = await res.text();
		const entries = parseDuckDuckGoHtml(html, opts.maxResults);
		if (entries.length === 0) {
			return { ok: false, backend: this.backend, failure: { code: "search_failed", message: "duckduckgo returned no parseable results" } };
		}
		// DDG keeps its native ranked shape: no forced answer (D6).
		return { ok: true, backend: this.backend, sources: entries };
	}
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchSource[] {
	const results: SearchSource[] = [];
	// Each result: <a ... class="result__a" href="...">Title</a> with a
	// sibling snippet element class="result__snippet".
	const itemPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a[^"]*"|<\/body>|$)/g;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(html)) !== null) {
		if (results.length >= maxResults) break;
		const rawHref = decodeEntities(match[1] ?? "");
		const title = decodeEntities(stripTags(match[2] ?? "")).trim();
		const tail = match[3] ?? "";
		const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(tail);
		const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1] ?? "")).trim() : undefined;
		const url = unwrapDdgHref(rawHref);
		if (!url) continue;
		results.push({
			url,
			...(title ? { title } : {}),
			...(snippet ? { snippet } : {}),
		});
	}
	return results;
}

function unwrapDdgHref(href: string): string | undefined {
	// DDG wraps external links as /l/?uddg=<encoded-url>&rut=...
	const uddg = /[?&]uddg=([^&]+)/.exec(href);
	if (uddg) {
		try {
			return decodeURIComponent(uddg[1]!);
		} catch {
			return undefined;
		}
	}
	if (/^https?:\/\//.test(href)) return href;
	return undefined;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'");
}

function ddgFailureMessage(err: unknown): string {
	if (err && typeof err === "object" && (err as { code?: string }).code === "cancelled") return "cancelled";
	const msg = err instanceof Error ? err.message : String(err);
	return `duckduckgo request failed: ${msg}`;
}

// ---------------------------------------------------------------------------
// Shared bounded fetch for search providers
// ---------------------------------------------------------------------------

async function fetchWithBudget(
	url: string,
	opts: {
		method: string;
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
		timeoutMs: number;
		maxBytes: number;
		fetchImpl: typeof fetch;
	},
): Promise<Response> {
	const timeout = AbortSignal.timeout(opts.timeoutMs);
	const signals = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	let res: Response;
	try {
		res = await opts.fetchImpl(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: signals });
	} catch (err) {
		if (opts.signal?.aborted) {
			const e = new Error("cancelled");
			(e as { code?: string }).code = "cancelled";
			throw e;
		}
		if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
			const e = new Error("timeout");
			(e as { code?: string }).code = "timeout";
			throw e;
		}
		throw err;
	}
	// Enforce the decoded-response cap without buffering unbounded.
	const reader = res.body?.getReader();
	if (!reader) return res;
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value?.length ?? 0;
		if (total > opts.maxBytes) {
			reader.cancel().catch(() => undefined);
			throw new TransportCapError("upstream response exceeds decoded cap");
		}
		chunks.push(value ?? new Uint8Array());
	}
	const combined = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		combined.set(c, off);
		off += c.length;
	}
	return new Response(combined, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export class TransportCapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransportCapError";
	}
}

// ---------------------------------------------------------------------------
// Assembly: auto/fallback, loud warning, output bound (D10)
// ---------------------------------------------------------------------------

export interface Searcher {
	search(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchOutcome>;
}

export class DefaultSearcher implements Searcher {
	private readonly gemini: GeminiAdapter;
	private readonly duck: DuckDuckGoAdapter;

	constructor(gemini: GeminiAdapter, duck: DuckDuckGoAdapter) {
		this.gemini = gemini;
		this.duck = duck;
	}

	async search(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchOutcome> {
		const opts: SearchOpts = { maxResults: config.maxResults, timeoutMs: config.timeoutMs, signal };
		const primaryAvailable = config.backend === "auto" ? Boolean(this.gemini.apiKey) : config.backend === "gemini";

		let primaryResult: SearchBackendResult | undefined;
		let usedFallback = false;
		let primaryFailure: string | undefined;

		if (config.backend === "gemini" || config.backend === "auto") {
			primaryResult = await this.gemini.search(query, opts);
			if (!primaryResult.ok) {
				primaryFailure = primaryResult.failure?.message;
				const isCancellation =
					primaryResult.failure?.message === "cancelled" || signal?.aborted === true;
				const mayFallback = config.backend === "auto" && !isCancellation;
				if (!mayFallback) {
					const code = primaryResult.failure?.message === "cancelled" ? "cancelled" : "search_failed";
					return {
						text: formatFailure(primaryResult.failure?.message ?? "search failed", code),
						details: { ok: false, code, backend: "gemini", resultCount: 0 },
					};
				}
				usedFallback = true;
			}
		}

		let result: SearchBackendResult;
		if (primaryResult?.ok) {
			result = primaryResult;
		} else {
			result = await this.duck.search(query, opts);
			if (!result.ok) {
				const both =
					`both backends failed: gemini: ${primaryFailure ?? "unavailable"}; ` +
					`duckduckgo: ${result.failure?.message ?? "failed"}`;
				return {
					text: formatFailure(both, "search_failed"),
					details: {
						ok: false,
						code: "search_failed",
						backend: "both",
						fallback: usedFallback,
						primaryAvailable,
						primaryFailure,
						resultCount: 0,
					},
				};
			}
		}

		const warnings: Warning[] = [...(result.warnings ?? [])];
		if (usedFallback) {
			warnings.unshift({ code: "fallback", message: FALLBACK_WARNING });
		}
		if (result.ungrounded) {
			warnings.push({ code: "ungrounded_answer", message: "answer has no attributed sources; not verified search evidence" });
		}

		const { text, truncated } = assembleSearchText(result, warnings, config.maxResults);
		return {
			text,
			details: {
				ok: true,
				backend: result.backend,
				fallback: usedFallback,
				primaryAvailable,
				...(primaryFailure ? { primaryFailure } : {}),
				...(result.answer !== undefined ? { answer: result.answer } : {}),
				sources: result.sources ?? [],
				resultCount: result.sources?.length ?? 0,
				truncated,
				warnings,
			},
		};
	}
}

function formatFailure(message: string, code: string): string {
	return `[web_search failed] ${code}: ${message}`;
}

/**
 * Assembles the model-facing search text, bounded at 51,200 UTF-8 bytes
 * including attribution and warnings. Answer/snippet text is shortened
 * before source attribution, valid UTF-8 is preserved, and omissions are
 * disclosed rather than implied complete (D10).
 */
export function assembleSearchText(
	result: SearchBackendResult,
	warnings: Warning[],
	maxResults: number,
): { text: string; truncated: boolean } {
	let answer = result.answer;
	const sources = (result.sources ?? []).slice(0, maxResults);
	let snippetsTrimmed = false;
	let truncated = false;

	const build = (): string => {
		const lines: string[] = [];
		lines.push(`[web_search] backend=${result.backend} results=${sources.length}`);
		if (answer) {
			lines.push("", "[answer]", answer);
		}
		if (sources.length > 0) {
			lines.push("", "[sources]");
			sources.forEach((s, i) => {
				lines.push(`${i + 1}. ${s.title ?? s.url ?? s.reference ?? "(no label)"}`);
				if (s.url) lines.push(`   ${s.url}`);
				if (s.snippet) lines.push(`   ${s.snippet}`);
			});
		}
		if (warnings.length > 0) {
			lines.push("", "[warnings]");
			for (const w of warnings) lines.push(`- ${w.message}`);
		}
		return lines.join("\n");
	};

	let text = build();
	// Shorten answer text before source attribution until the budget fits.
	let guard = 0;
	while (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES && answer && guard++ < 200) {
		answer = cutToBytes(answer, Math.floor(answer.length * 0.75) + 1);
		truncated = true;
		text = build();
	}
	// Then shorten snippets.
	if (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES && !snippetsTrimmed) {
		snippetsTrimmed = true;
		for (const s of sources) {
			if (s.snippet && s.snippet.length > 120) s.snippet = cutToBytes(s.snippet, 120);
		}
		truncated = true;
		text = build();
	}
	// Last resort: drop trailing sources, keeping the attribution order intact.
	let guard2 = 0;
	while (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES && sources.length > 1 && guard2++ < 50) {
		sources.pop();
		truncated = true;
		text = build();
	}
	if (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES) {
		// Still over: hard cut on a character boundary and disclose.
		const marker = "\n[truncated: result exceeded the 51,200-byte output budget]";
		text = cutToBytes(text, SEARCH_OUTPUT_MAX_BYTES - utf8Bytes(marker)) + marker;
		truncated = true;
	}
	if (truncated && !text.includes("[truncated:")) {
		const marker = "\n[truncated: answer or snippets shortened to fit the 51,200-byte output budget]";
		if (utf8Bytes(text) + utf8Bytes(marker) > SEARCH_OUTPUT_MAX_BYTES) {
			// Reserve room for the disclosure itself.
			text = cutToBytes(text, SEARCH_OUTPUT_MAX_BYTES - utf8Bytes(marker) - 1);
		}
		text += marker;
	}
	return { text, truncated };
}

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Cuts a string to at most max UTF-8 bytes without splitting a codepoint. */
export function cutToBytes(value: string, maxBytes: number): string {
	if (utf8Bytes(value) <= maxBytes) return value;
	const ellipsis = "\u2026";
	const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
	let out = "";
	let bytes = 0;
	for (const ch of value) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > budget) break;
		out += ch;
		bytes += size;
	}
	return out + ellipsis;
}
