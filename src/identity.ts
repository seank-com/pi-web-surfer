import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Identity derivation. The artifact namespace is per-project: the project
 * hash derives from the absolute working-directory path, so URL (or file
 * path) alone never identifies an artifact.
 */

export function sha256Hex(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Stable 16-hex-char project namespace key from the absolute working dir. */
export function projectHash(cwd: string): string {
	return sha256Hex(path.resolve(cwd)).slice(0, 16);
}

export interface RequestIdentity {
	/** Stable directory name for the artifact namespace entry. */
	key: string;
	/** Human-safe description used in error text and diagnostics. */
	description: string;
}

/**
 * Request identity per the D14 reconciliation: plain GETs are keyed by
 * project + URL; injected requests (non-GET, body, or custom headers) add
 * method plus a digest of the sorted headers and body; path reads are keyed
 * by path + size + mtime.
 */
export function urlRequestIdentity(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}): RequestIdentity {
	const injected =
		(opts.method && opts.method !== "GET") ||
		(opts.body !== undefined) ||
		Object.keys(opts.headers ?? {}).length > 0;
	if (!injected) {
		return { key: sha256Hex(opts.url).slice(0, 32), description: opts.url };
	}
	const headerDigest = Object.entries(opts.headers ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	const digestInput = `${opts.url}\n${opts.method ?? "GET"}\n${headerDigest}\n${opts.body ?? ""}`;
	return {
		key: sha256Hex(digestInput).slice(0, 32),
		description: `${opts.method ?? "GET"} ${opts.url}`,
	};
}

export function pathRequestIdentity(opts: {
	path: string;
	size: number;
	mtimeMs: number;
}): RequestIdentity {
	return {
		key: sha256Hex(`${opts.path}\n${opts.size}\n${opts.mtimeMs}`).slice(0, 32),
		description: `file:${opts.path}`,
	};
}
