import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ConfigLoadResult } from "./config.ts";
import { KeyLock, cleanupExpired } from "./artifacts.ts";
import { projectHash } from "./identity.ts";
import { executeFetch, type FetchEnvironment } from "./fetchcore.ts";
import { discoverDatastoreBoundary, type DatastoreBoundary, type EventBusLike } from "./policy.ts";
import { DefaultSearcher, DuckDuckGoAdapter, GeminiAdapter, type Searcher } from "./search.ts";
import type { FetchDetails, SearchDetails } from "./types.ts";

/**
 * Tool registration for web_fetch and web_search (D12).
 *
 * Tools register during extension initialization; session configuration and
 * resources initialize at session_start; no network requests happen at load
 * or session start. Cancellation signals pass through all owned work; owned
 * resources close idempotently at session_shutdown. The core works without a
 * terminal UI.
 */

const FetchSchema = Type.Object({
	url: Type.Optional(
		Type.String({ description: "Absolute HTTP(S) URL to fetch. Mutually exclusive with path." }),
	),
	path: Type.Optional(
		Type.String({
			description: "Local file path to read instead of a URL (no network). Mutually exclusive with url.",
		}),
	),
	method: Type.Optional(
		Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT")], {
			description: "HTTP method for URL fetches. POST/PUT accept a body and headers.",
		}),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Request headers for POST/PUT. Values may use {{env:NAME}} placeholders; literal credentials must not be passed.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"Request body for POST/PUT. May use {{env:NAME}}, {{file:path}}, and {{template:path,{vars}}} placeholders.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("readable"), Type.Literal("raw")], {
			description: "readable (default): HTML extracted to Markdown. raw: no extraction.",
		}),
	),
	offset: Type.Optional(
		Type.Number({ description: "Byte offset in the served text for paging. Default 0." }),
	),
	chunkBytes: Type.Optional(
		Type.Number({ description: "Per-call response page byte budget (max 256000)." }),
	),
	maxBodyBytes: Type.Optional(
		Type.Number({ description: "Per-call download cap for a new fetch (max 64 MiB)." }),
	),
	artifactId: Type.Optional(
		Type.String({
			description: "Pin an existing response for paging or saving. Omit url/path when set.",
		}),
	),
	refresh: Type.Optional(
		Type.Boolean({ description: "Force a new fetch instead of reusing a fresh artifact. Default false." }),
	),
	saveTo: Type.Optional(
		Type.String({
			description: "Project-relative destination for the stored source bytes. Never overwrites.",
		}),
	),
});

const SearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum sources/results, 1-10. Defaults to configured maxResults." }),
	),
});

export type FetchParams = Static<typeof FetchSchema>;
export type SearchParams = Static<typeof SearchSchema>;

export interface SessionState {
	config: ConfigLoadResult;
	boundary: DatastoreBoundary;
	lock: KeyLock;
	searcher: Searcher;
	controller:AbortController;
	configDirName:string;
}

export interface WebSurferHost {
	cwd: string;
	configDirName?: string;
	events?: EventBusLike;
	signal?: AbortSignal;
	lookupImpl?: (hostname: string) => Promise<string[]>;
}

export async function createSessionState(host: WebSurferHost): Promise<SessionState> {
	const config = loadConfig(host.cwd, host.configDirName ?? ".pi");
	const boundary = await discoverDatastoreBoundary(host.events, host.cwd, host.configDirName ?? ".pi");
	return {
		config,
		boundary,
		lock: new KeyLock(),
		searcher: new DefaultSearcher(new GeminiAdapter(), new DuckDuckGoAdapter()),
		controller:new AbortController(),configDirName:host.configDirName??'.pi',
	};
}

function signalOf(ctx:ExtensionContext,state:SessionState,toolSignal?:AbortSignal):AbortSignal{return AbortSignal.any([state.controller.signal,...(ctx.signal?[ctx.signal]:[]),...(toolSignal?[toolSignal]:[])]);}
function envOf(ctx: ExtensionContext, state: SessionState,toolSignal?:AbortSignal): FetchEnvironment {
	return {
		cwd: ctx.cwd,
		configDirName: state.configDirName,
		config: state.config,
		boundary: state.boundary,
		lock: state.lock,
		signal: signalOf(ctx,state,toolSignal),
	};
}

export function registerWebSurferTools(pi: ExtensionAPI, getState: (ctx: ExtensionContext) => SessionState | undefined): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		promptSnippet: "Fetch a URL or local file as stored, paged source evidence.",
		description: [
			"Fetch an HTTP(S) URL or read a local file, store the source bytes outside model context, and serve bounded pages without re-downloading.",
			"",
			"- `url` (absolute HTTP(S)) or `path` (local file; no network) — exactly one.",
			"- `mode`: `readable` (default, HTML extracted to Markdown) or `raw` (no extraction).",
			"- Paging: pass the returned `artifactId` plus `offset`/`nextOffset` to continue; `refresh` forces a new fetch.",
			"- `saveTo`: project-relative destination for the stored source bytes (never overwrites).",
			"- POST/PUT with `body` and `headers` for request injection. Templates: `{{env:NAME}}`, `{{file:path}}`, `{{template:path,{\"var\":\"value\"}}}`.",
			"- Non-2xx responses keep their body with the status disclosed as a warning.",
			"- Binary responses are stored artifacts, not inline text.",
			"",
			"Intent example: \"Retrieve the release notes page and read the first 51,200 bytes as Markdown.\"",
		].join("\n"),
		parameters: FetchSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			if (!state) {
				return {
					content: [{ type: "text", text: "[web_fetch unavailable] session state not initialized" }],
					details: { ok: false, code: "config_invalid", sourceUrl: "" } satisfies FetchDetails,
				};
			}
			const result = await executeFetch(
				{
					url: params.url,
					filePath: params.path,
					method: params.method,
					headers: params.headers,
					body: params.body,
					mode: params.mode,
					offset: params.offset,
					chunkBytes: params.chunkBytes,
					maxBodyBytes: params.maxBodyBytes,
					artifactId: params.artifactId,
					refresh: params.refresh,
					saveTo: params.saveTo,
				},
				envOf(ctx, state,_signal),
			);
			return result;
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		promptSnippet: "Search the web via Google grounding (primary) or DuckDuckGo (fallback).",
		description: [
			"Search the web. Primary backend: Google Gemini Google Search grounding (requires GEMINI_API_KEY). DuckDuckGo HTML is selected automatically only without a key; Gemini errors never trigger a backend switch.",
			"",
			"- `query` (required). `maxResults` 1-10 (default from project config, 10).",
			"- Results preserve provider order and content; sources may be absent (ungrounded answers are labeled).",
			"- Automatic selection uses DuckDuckGo only without a Gemini key: [WARNING: Gemini key is not configured; using DuckDuckGo.]",
			"",
			"Intent example: \"Check whether the release notes describe a changed API.\"",
		].join("\n"),
		parameters: SearchSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const state = getState(ctx);
			if (!state) {
				return {
					content: [{ type: "text", text: "[web_search unavailable] session state not initialized" }],
					details: { ok: false, code: "config_invalid", backend: "none", resultCount: 0 } satisfies SearchDetails,
				};
			}
			const config = state.config;
			if (config.invalid) {
				return {
					content: [
						{
							type: "text",
							text: `[web_search unavailable] config_invalid: ${config.invalid}. Search is disabled until the project configuration is corrected.`,
						},
					],
					details: { ok: false, code: "config_invalid", backend: "none", resultCount: 0 } satisfies SearchDetails,
				};
			}
			if (params.maxResults !== undefined && (!Number.isSafeInteger(params.maxResults) || params.maxResults < 1 || params.maxResults > 10)) {
				return {
					content: [{ type: "text", text: "[web_search failed] invalid_input: maxResults must be an integer between 1 and 10" }],
					details: { ok: false, code: "invalid_input", backend: "none", resultCount: 0 } satisfies SearchDetails,
				};
			}
			const effectiveConfig = {
				...config.config!.search,
				...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
			};
			const outcome = await state.searcher.search(params.query, effectiveConfig, signalOf(ctx,state,_signal));
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
		},
	});
}

export function registerWebSurferSession(
	pi: ExtensionAPI,
	piState: { current?: SessionState },
	piConfigDirName?: string,
): void {
	pi.on("session_start", async (_event, ctx) => {
		const host: WebSurferHost = {
			cwd: ctx.cwd,
			configDirName: piConfigDirName ?? ".pi",
			events: pi.events as EventBusLike,
		};
		piState.current?.controller.abort();
		piState.current=undefined;
		const state = await createSessionState(host);
		await cleanupExpired(projectHash(ctx.cwd));
		piState.current = state;
	});
	pi.on("session_shutdown", async () => {
		piState.current?.controller.abort();
		piState.current = undefined;
	});
}

export function getStateForCtx(piState: { current?: SessionState }, _ctx: ExtensionContext): SessionState | undefined {
	return piState.current;
}
