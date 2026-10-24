import type { SearchConfig } from "./config.ts";
import type { SearchDetails, SearchSource, Warning } from "./types.ts";
import { readResponseBody } from "./transport.ts";
export const FALLBACK_WARNING = "[WARNING: Gemini key is not configured; using DuckDuckGo.]";
export const SEARCH_OUTPUT_MAX_BYTES = 51200;
export const SEARCH_UPSTREAM_MAX_BYTES = 1048576;
export const GEMINI_MODEL = "gemini-2.5-flash";
export interface SearchOpts {
	maxResults: number;
	signal?: AbortSignal;
}
export interface SearchBackendResult {
	ok: boolean;
	backend: string;
	answer?: string;
	sources?: SearchSource[];
	ungrounded?: boolean;
	warnings?: Warning[];
	failure?: { code: "key_unavailable" | "search_failed"; message: string };
}
export interface SearchAdapter {
	backend: string;
	search(query: string, opts: SearchOpts): Promise<SearchBackendResult>;
}
export interface SearchOutcome {
	text: string;
	details: SearchDetails;
}
export interface Searcher {
	search(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchOutcome>;
}
export interface GeminiAdapterOptions {
	apiKey?: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}
function failure(
	backend: string,
	message: string,
	code: "key_unavailable" | "search_failed" = "search_failed",
): SearchBackendResult {
	return { ok: false, backend, failure: { code, message } };
}
async function fetchBounded(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
	const response = await fetchImpl(url, init);
	const bytes = await readResponseBody(response, SEARCH_UPSTREAM_MAX_BYTES, init.signal ?? undefined);
	return new Response(new Uint8Array(bytes), { status: response.status, headers: response.headers });
}
function isGroundingLink(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "vertexaisearch.cloud.google.com" &&
			url.pathname.startsWith("/grounding-api-redirect/")
		);
	} catch {
		return false;
	}
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
		if (!key) return failure(this.backend, "GEMINI_API_KEY is not available", "key_unavailable");
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		try {
			opts.signal?.throwIfAborted();
			const response = await fetchBounded(
				`${this.opts.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${GEMINI_MODEL}:generateContent`,
				{
					method: "POST",
					headers: { "x-goog-api-key": key, "content-type": "application/json" },
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [{ text: `Use Google Search grounding to find current information about: ${query}` }],
							},
						],
						tools: [{ google_search: {} }],
					}),
					signal: opts.signal,
				},
				fetchImpl,
			);
			if (!response.ok) return failure(this.backend, `gemini request failed (HTTP ${response.status})`);
			let doc: any;
			try {
				doc = JSON.parse(await response.text());
			} catch {
				return failure(this.backend, "gemini returned invalid JSON");
			}
			const candidates = Array.isArray(doc?.candidates) ? doc.candidates : [];
			const parts = Array.isArray(candidates[0]?.content?.parts) ? candidates[0].content.parts : [];
			const answer =
				parts
					.map((p: any) => (typeof p?.text === "string" ? p.text : ""))
					.join("")
					.trim() || undefined;
			const sources: SearchSource[] = [];
			const warnings: Warning[] = [];
			for (const candidate of candidates) {
				const chunks = Array.isArray(candidate?.groundingMetadata?.groundingChunks)
					? candidate.groundingMetadata.groundingChunks
					: [];
				for (const chunk of chunks) {
					if (sources.length >= opts.maxResults) break;
					const uri = typeof chunk?.web?.uri === "string" ? chunk.web.uri : undefined;
					const title = typeof chunk?.web?.title === "string" ? chunk.web.title : undefined;
					const source: SearchSource = { ...(title ? { title } : {}) };
					if (uri && /^https?:\/\//.test(uri)) source.url = uri;
					else source.reference = typeof chunk?.reference === "string" ? chunk.reference : JSON.stringify(chunk ?? {});
					if (source.url && isGroundingLink(source.url)) {
						const reference = source.url;
						let resolved = false;
						try {
							const result = await fetchImpl(reference, { redirect: "manual", signal: opts.signal });
							try {
								const location = result.headers.get("location");
								if ([301, 302, 303, 307, 308].includes(result.status) && location) {
									const target = new URL(location, reference);
									if (["http:", "https:"].includes(target.protocol) && !isGroundingLink(target.href)) {
										source.url = target.href;
										resolved = true;
									}
								}
							} finally {
								await result.body?.cancel();
							}
						} catch {
							opts.signal?.throwIfAborted();
						}
						if (!resolved) {
							source.reference = reference;
							delete source.url;
						}
					}
					if (!source.url)
						warnings.push({
							code: "source_unresolved",
							message: "Source link unresolved; provider reference preserved",
						});
					sources.push(source);
				}
			}
			if (!answer && !sources.length) return failure(this.backend, "gemini returned neither an answer nor sources");
			return { ok: true, backend: this.backend, answer, sources, ungrounded: !!answer && !sources.length, warnings };
		} catch {
			return failure(this.backend, opts.signal?.aborted ? "cancelled" : "gemini request failed");
		}
	}
}
export interface DuckDuckGoAdapterOptions {
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
		try {
			opts.signal?.throwIfAborted();
			const response = await fetchBounded(
				`${this.opts.baseUrl ?? "https://html.duckduckgo.com"}/html/?q=${encodeURIComponent(query)}`,
				{ signal: opts.signal, headers: { accept: "text/html" } },
				this.opts.fetchImpl ?? fetch,
			);
			if (!response.ok) return failure(this.backend, `duckduckgo request failed (HTTP ${response.status})`);
			const sources = parseDuckDuckGoHtml(await response.text(), opts.maxResults);
			return sources.length
				? { ok: true, backend: this.backend, sources }
				: failure(this.backend, "duckduckgo returned no parseable results");
		} catch {
			return failure(this.backend, opts.signal?.aborted ? "cancelled" : "duckduckgo request failed");
		}
	}
}
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchSource[] {
	const sources: SearchSource[] = [];
	const pattern =
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a[^"]*"|<\/body>|$)/g;
	for (const match of html.matchAll(pattern)) {
		if (sources.length >= maxResults) break;
		const href = entities(match[1]!);
		const wrapped = /[?&]uddg=([^&]+)/.exec(href);
		let url: string;
		try {
			url = wrapped ? decodeURIComponent(wrapped[1]!) : href;
		} catch {
			continue;
		}
		if (!/^https?:\/\//.test(url)) continue;
		const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(match[3]!);
		sources.push({
			url,
			title: entities(match[2]!.replace(/<[^>]*>/g, "")).trim(),
			...(snippet ? { snippet: entities(snippet[1]!.replace(/<[^>]*>/g, "")).trim() } : {}),
		});
	}
	return sources;
}
function entities(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(?:x27|39);/g, "'");
}
export class DefaultSearcher implements Searcher {
	private readonly gemini: GeminiAdapter;
	private readonly duck: DuckDuckGoAdapter;
	constructor(gemini: GeminiAdapter, duck: DuckDuckGoAdapter) {
		this.gemini = gemini;
		this.duck = duck;
	}
	async search(query: string, config: SearchConfig, signal?: AbortSignal): Promise<SearchOutcome> {
		const missingKey = !this.gemini.apiKey;
		const fallback = config.backend === "auto" && missingKey;
		const adapter = config.backend === "duckduckgo" || fallback ? this.duck : this.gemini;
		const result = await adapter.search(query, { maxResults: config.maxResults, signal });
		if (!result.ok) {
			const code = signal?.aborted ? "cancelled" : (result.failure?.code ?? "search_failed");
			return {
				text: `[web_search failed] ${code}: ${result.failure?.message ?? "search failed"}`,
				details: { ok: false, code, backend: adapter.backend, resultCount: 0, fallback },
			};
		}
		const warnings = [...(result.warnings ?? [])];
		if (fallback) warnings.unshift({ code: "fallback", message: FALLBACK_WARNING });
		if (result.ungrounded)
			warnings.push({
				code: "ungrounded_answer",
				message: "Answer has no attributed sources; not verified search evidence",
			});
		const formatted = assembleSearchText(result, warnings, config.maxResults);
		return {
			text: formatted.text,
			details: {
				ok: true,
				backend: result.backend,
				fallback,
				primaryAvailable: !missingKey,
				answer: result.answer,
				sources: result.sources ?? [],
				resultCount: result.sources?.length ?? 0,
				truncated: formatted.truncated,
				warnings,
			},
		};
	}
}
export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
export function cutToBytes(value: string, maxBytes: number): string {
	let out = "";
	let bytes = 0;
	for (const ch of value) {
		const size = utf8Bytes(ch);
		if (bytes + size > maxBytes) break;
		out += ch;
		bytes += size;
	}
	return out;
}
export function assembleSearchText(
	result: SearchBackendResult,
	warnings: Warning[],
	maxResults: number,
): { text: string; truncated: boolean } {
	let answer = result.answer ?? "";
	const sources = (result.sources ?? []).slice(0, maxResults).map((s) => ({ ...s }));
	let truncated = false;
	let omitted = 0;
	const marker = () => (truncated ? `\n[truncated: answer/snippets shortened; ${omitted} source entries omitted]` : "");
	const build = () =>
		[
			`[web_search] backend=${result.backend} results=${sources.length}`,
			answer,
			...sources.map(
				(s, i) =>
					`${i + 1}. ${s.title ?? s.reference ?? s.url ?? ""}${s.url ? "\n" + s.url : ""}${s.snippet ? "\n" + s.snippet : ""}`,
			),
			...warnings.map((w) => w.message),
		]
			.filter(Boolean)
			.join("\n") + marker();
	let text = build();
	while (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES && answer.length) {
		answer = cutToBytes(answer, Math.floor(utf8Bytes(answer) / 2));
		truncated = true;
		text = build();
	}
	if (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES) {
		for (const s of sources) delete s.snippet;
		truncated = true;
		text = build();
	}
	while (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES && sources.length > 1) {
		sources.pop();
		omitted++;
		truncated = true;
		text = build();
	}
	if (utf8Bytes(text) > SEARCH_OUTPUT_MAX_BYTES) {
		const notice = "\n[truncated: source attribution exceeded output limit]";
		text = cutToBytes(text, SEARCH_OUTPUT_MAX_BYTES - utf8Bytes(notice)) + notice;
		truncated = true;
	}
	return { text, truncated };
}
