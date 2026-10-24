/**
 * Shared result types and stable code vocabulary for web_fetch and
 * web_search. Expected failures return model-readable text with
 * `details.ok: false` and a stable code; warnings accompany usable
 * content with `details.ok: true`. Unexpected programming failures
 * remain execution failures.
 */

/** Stable failure codes (D11; D14 adds env_unavailable, template_error). */
import type {ArtifactMeta} from './artifacts.ts';

export const FAILURE_CODES = [
	"conversion_failed",
	"malformed_url",
	"unsupported_scheme",
	"config_invalid",
	"blocked_origin",
	"refused_redirect",
	"redirect_limit",
	"invalid_offset",
	"invalid_input",
	"dns_failed",
	"connection_failed",
	"timeout",
	"cancelled",
	"size_exceeded",
	"artifact_error",
	"artifact_unavailable",
	"destination_blocked",
	"save_failed",
	"key_unavailable",
	"search_failed",
	"env_unavailable",
	"template_error",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Stable warning codes that accompany usable content. */
export const WARNING_CODES = [
	"http_error",
	"source_unresolved",
	"ungrounded_answer",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface Warning {
	code: string;
	message: string;
}

export interface BaseDetails {
	ok: boolean;
	/** Present when ok is false. Stable code from the reviewed vocabulary. */
	code?: FailureCode | string;
	warnings?: Warning[];
}

export interface FetchDetails extends BaseDetails {
	sourceUrl: string;
	finalUrl?: string;
	path?: string;
	method?: string;
	httpStatus?: number;
	contentType?: string;
	fetchedAt?: string;
	artifactId?: string;
	sourceArtifactId?: string;
	provenance?: ArtifactMeta['provenance'];
	mode?: string;
	totalTextBytes?: number;
	returnedBytes?: number;
	offset?: number;
	nextOffset?: number;
	endOfFile?: boolean;
	sizeBytes?: number;
	bytesRead?:number;
	capBytes?:number;
	sizeActual?: number;
	sizeCapped?: boolean;
	savedPath?: string;
	binary?: boolean;
}

export interface SearchSource {
	url?: string;
	/** Provider reference kept verbatim when no resolved URL is available. */
	reference?: string;
	title?: string;
	snippet?: string;
}

export interface SearchDetails extends BaseDetails {
	backend?: string;
	fallback?: boolean;
	primaryAvailable?: boolean;
	primaryFailure?: string;
	answer?: string;
	sources?: SearchSource[];
	resultCount?: number;
	truncated?: boolean;
}

/** Model-facing text plus structured details, as returned by both tools. */
export interface ToolOutput<TDetails extends BaseDetails> {
	content: { type: "text"; text: string }[];
	details: TDetails;
}
