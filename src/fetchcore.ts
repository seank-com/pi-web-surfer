import { constants as fsConstants } from "node:fs";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { ConfigLoadResult, FetchConfig } from "./config.ts";
import { BODY_BYTES_CEILING, CHUNK_BYTES_CEILING, DEFAULT_CONFIG } from "./config.ts";
import {
	CancelledError,
	KeyLock,
	isCancelledError,
	isExpired,
	markLatest,
	publishArtifact,
	readArtifactMeta,
	readLatest,
	readRepresentation,
	readSourceBytes,
	storeRepresentation,
	type ArtifactMeta,
} from "./artifacts.ts";
import { represent } from "./extract.ts";
import { pathRequestIdentity, projectHash, urlRequestIdentity } from "./identity.ts";
import { checkDestination, type DatastoreBoundary } from "./policy.ts";
import { httpFetch, TransportError } from "./transport.ts";
import { resolveTopLevelTemplate, isTemplateError } from "./templates.ts";
import type { FetchDetails, ToolOutput, Warning } from "./types.ts";

/**
 * web_fetch orchestration. Combines config, request identity, transport,
 * extraction, artifact storage, template injection, and the datastore
 * destination boundary. See docs/design.md for the full contract.
 */

export interface FetchRequest {
	url?: string;
	filePath?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	mode?: "readable" | "raw";
	offset?: number;
	chunkBytes?: number;
	maxBodyBytes?: number;
	artifactId?: string;
	refresh?: boolean;
	saveTo?: string;
}

export interface FetchEnvironment {
	cwd: string;
	configDirName?: string;
	config: ConfigLoadResult;
	boundary: DatastoreBoundary;
	lock: KeyLock;
	signal?: AbortSignal;
	/** Test seam: DNS override for the deny policy. */
	lookupImpl?: (hostname: string) => Promise<string[]>;
}

export type FetchResult = ToolOutput<FetchDetails>;

function configInvalid(message: string | undefined): FetchResult {
	const reason = message ?? "unknown";
	return {
		content: [{ type: "text", text: `[web_fetch unavailable] config_invalid: ${reason}. Network operations are disabled until the project configuration is corrected.` }],
		details: { ok: false, code: "config_invalid", sourceUrl: "" },
	};
}

export async function executeFetch(req: FetchRequest, env: FetchEnvironment): Promise<FetchResult> {
	const projectHashValue = projectHash(env.cwd);
	const configDirName = env.configDirName ?? ".pi";
	const configDir = path.join(env.cwd, configDirName);
	const mode = req.mode ?? "readable";

	// ---- input validation (config-invalid only blocks network ops) ----
	if (req.artifactId) {
		if (req.url !== undefined || req.filePath !== undefined) {
			return fail("artifact_error", `artifactId cannot be combined with url or path: omit both and page by artifactId only`);
		}
		if (req.refresh) {
			return fail("invalid_input", "refresh cannot be combined with an existing artifactId");
		}
		return executePaging(req, env, projectHashValue, mode);
	}

	const hasUrl = req.url !== undefined;
	const hasPath = req.filePath !== undefined;
	if (hasUrl === hasPath) {
		return fail("malformed_url", "exactly one of url or path is required");
	}
	if (!hasUrl && env.config.invalid) {
		// Local path reads are not network operations; they proceed.
	} else if (hasUrl && env.config.invalid) {
		return configInvalid(env.config.invalid);
	}

	const cfg: FetchConfig = env.config.config?.fetch ?? DEFAULT_CONFIG.fetch;
	const maxBodyBytes = positiveIntOr(req.maxBodyBytes, cfg.maxBodyBytes);
	if (maxBodyBytes === undefined || maxBodyBytes > BODY_BYTES_CEILING) {
		return fail("invalid_input", `maxBodyBytes must be a positive integer at most ${BODY_BYTES_CEILING}`);
	}
	const chunkBytes = positiveIntOr(req.chunkBytes, cfg.chunkBytes);
	if (chunkBytes === undefined || chunkBytes > CHUNK_BYTES_CEILING) {
		return fail("invalid_input", `chunkBytes must be a positive integer at most ${CHUNK_BYTES_CEILING}`);
	}
	if (req.offset !== undefined && (!Number.isSafeInteger(req.offset) || req.offset < 0)) {
		return fail("invalid_offset", "offset must be a nonnegative safe integer byte offset");
	}
	const method = (req.method ?? "GET").toUpperCase();
	if (!["GET", "POST", "PUT"].includes(method)) {
		return fail("invalid_input", `method must be GET, POST, or PUT`);
	}

	let body: string | undefined;
	let headers: Record<string, string> = {};
	const warnings: Warning[] = [];
	if (req.body !== undefined || req.headers !== undefined) {
		if (method === "GET") {
			return fail("invalid_input", "body and headers require POST or PUT");
		}
		try {
			if (req.body !== undefined) {
				const resolved = resolveTopLevelTemplate(req.body, process.env);
				if (resolved.missingEnv) {
					return fail("env_unavailable", `environment variable for {{env:${resolved.missingEnv}}} is not set`);
				}
				body = resolved.value;
				for (const w of resolved.warnings) warnings.push({ code: "template_error", message: w.message });
			}
			for (const [k, v] of Object.entries(req.headers ?? {})) {
				const resolved = resolveTopLevelTemplate(v, process.env);
				if (resolved.missingEnv) {
					return fail("env_unavailable", `environment variable for {{env:${resolved.missingEnv}}} is not set (header ${k})`);
				}
				headers[k] = resolved.value;
				for (const w of resolved.warnings) warnings.push({ code: "template_error", message: w.message });
			}
		} catch (err) {
			if (isTemplateError(err)) {
				return fail("template_error", `template resolution failed: ${err.message}`);
			}
			throw err;
		}
	}

	const identity = hasPath
		? await pathReadIdentity(req.filePath!, env.cwd)
		: urlRequestIdentity({ url: req.url!, method, headers, body });
	if (!identity) {
		return fail("artifact_error", `cannot read local path: ${req.filePath}`);
	}

	const keyLockKey = `${projectHashValue}/${identity.key}`;
	try {
		return await env.lock.run(keyLockKey, env.signal, async () => {
			// ---- reuse decision ----
			if (!req.refresh) {
				const latestId = await readLatest(projectHashValue, identity.key);
				if (latestId) {
					const meta = await readArtifactMeta(projectHashValue, identity.key, latestId);
					const reusable =
						meta &&
						!isExpired(meta) &&
						((meta.sourceKind === "path") ||
							// Automatic reuse applies only to plain GET responses (D14):
							// error bodies are not reused for a new URL-only read (D4).
							(meta.httpStatus === undefined || meta.httpStatus < 400));
					if (reusable) {
						return serveFromArtifact(meta!, env, projectHashValue, mode, req.offset ?? 0, chunkBytes, warnings, req.saveTo, configDir);
					}
				}
			}

			// ---- new fetch / read ----
			let meta: Omit<ArtifactMeta, "artifactId" | "fetchedAt" | "expiresAt">;
			let sourceBytes: Buffer;
			if (hasPath) {
				const read = await readLocalFile(req.filePath!, maxBodyBytes, env.cwd);
				if ("error" in read) return read.error;
				meta = {
					requestKey: identity.key,
					projectHash: projectHashValue,
					sourceKind: "path",
					filePath: read.absolute,
					contentType: read.contentType,
					sizeBytes: read.bytes.length,
				};
				sourceBytes = read.bytes;
			} else {
				try {
					const transport = await httpFetch({
						url: req.url!,
						method,
						headers,
						body,
						config: { ...cfg, maxBodyBytes },
						signal: env.signal,
						lookupImpl: env.lookupImpl,
					});
					meta = {
						requestKey: identity.key,
						projectHash: projectHashValue,
						sourceKind: "url",
						sourceUrl: req.url,
						finalUrl: transport.finalUrl,
						method,
						httpStatus: transport.status,
						contentType: transport.headers["content-type"],
						sizeBytes: transport.body.length,
						...(transport.sizeActual !== undefined ? { sizeActual: transport.sizeActual } : {}),
						...(transport.sizeCapped ? { sizeCapped: true } : {}),
					};
					sourceBytes = transport.body;
					if (transport.status >= 400) {
						warnings.push({ code: "http_error", message: `HTTP ${transport.status} from ${transport.finalUrl}; body retained` });
					}
					if (transport.sizeCapped) {
						warnings.push({ code: "size_exceeded", message: `body was capped at ${maxBodyBytes} bytes during decode` });
					}
				} catch (err) {
					if (err instanceof TransportError) {
						const extra = err.extra
							? ` (declared ${err.extra.declaredBytes ?? "?"} bytes, cap ${maxBodyBytes})`
							: "";
						return fail(err.code, `${err.message}${extra}`);
					}
					if (err instanceof CancelledError || isCancelledError(err) || env.signal?.aborted) {
						return fail("cancelled", "fetch cancelled before completion; no artifact was published");
					}
					throw err;
				}
			}

			const published = await publishArtifact(projectHashValue, identity.key, meta, sourceBytes);
			await markLatest(projectHashValue, identity.key, published.artifactId);
			return serveFromArtifact(published, env, projectHashValue, mode, req.offset ?? 0, chunkBytes, warnings, req.saveTo, configDir);
		});
	} catch (err) {
		if (err instanceof CancelledError || isCancelledError(err) || env.signal?.aborted) {
			return fail("cancelled", "operation cancelled; unfinished work was cleaned up");
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Local path reads
// ---------------------------------------------------------------------------

async function pathReadIdentity(p: string, cwd: string): Promise<{ key: string; description: string } | undefined> {
	try {
		const absolute = path.resolve(cwd, p);
		const info = await stat(absolute);
		return pathRequestIdentity({ path: absolute, size: info.size, mtimeMs: info.mtimeMs });
	} catch {
		return undefined;
	}
}

async function readLocalFile(
	p: string,
	maxBytes: number,
	cwd: string,
): Promise<
	| { bytes: Buffer; absolute: string; contentType?: string }
	| { error: FetchResult }
> {
	const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
	try {
		const info = await lstat(absolute);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { error: fail("artifact_error", `path is not a regular file: ${p}`) };
		}
		if (info.size > maxBytes) {
			return {
				error: fail(
					"size_exceeded",
					`file size ${info.size} exceeds cap ${maxBytes}; repeat with a higher maxBodyBytes`,
				),
			};
		}
		const handle = await open(absolute, "r");
		try {
			const buffer = Buffer.alloc(info.size);
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const bytes = buffer.subarray(0, offset);
			const ext = absolute.toLowerCase().split(".").pop();
			const contentType =
				ext === "html" || ext === "htm" ? "text/html" : ext === "xml" ? "application/xml" : ext === "json" ? "application/json" : ext === "txt" || ext === "md" ? "text/plain" : undefined;
			return { bytes, absolute, contentType };
		} finally {
			await handle.close();
		}
	} catch (err) {
		return { error: fail("artifact_error", `cannot read path: ${p}`) };
	}
}

// ---------------------------------------------------------------------------
// Serving: representations, paging, saveTo
// ---------------------------------------------------------------------------

async function serveFromArtifact(
	meta: ArtifactMeta,
	env: FetchEnvironment,
	projectHashValue: string,
	mode: "readable" | "raw",
	offset: number,
	chunkBytes: number,
	warnings: Warning[],
	saveTo: string | undefined,
	configDir: string,
): Promise<FetchResult> {
	const sourceBytes = await readSourceBytes(projectHashValue, meta.requestKey, meta.artifactId);
	if (sourceBytes === undefined) {
		return fail("artifact_unavailable", `artifact ${meta.artifactId} no longer exists (expired or cleaned up); start again`);
	}

	let text: Buffer | undefined;
	let binary = false;
	let extractionWarning: Warning | undefined;

	let rep = await readRepresentation(projectHashValue, meta.requestKey, meta.artifactId, mode);
	if (rep === undefined) {
		try {
			const representation = represent(
				{
					bytes: sourceBytes,
					contentType: meta.contentType,
					sourcePath: meta.sourceKind === "path" ? meta.filePath : undefined,
				},
				mode,
			);
			if (representation.kind === "text") {
				rep = representation.text;
				text = representation.text;
			} else {
				binary = true;
			}
			if (rep !== undefined) {
				await storeRepresentation(projectHashValue, meta.requestKey, meta.artifactId, mode, rep);
			}
		} catch (err) {
			// Extraction failure: honest raw-text fallback (D8).
			extractionWarning = { code: "extraction_failed", message: `extraction failed (${errMessage(err)}); serving raw text` };
			warnings.push(extractionWarning);
			const raw = represent({ bytes: sourceBytes, contentType: "text/plain", sourcePath: undefined }, "raw");
			if (raw.kind === "text") {
				text = raw.text;
				rep = raw.text;
			} else {
				binary = true;
			}
			if (rep !== undefined && !binary) {
				await storeRepresentation(projectHashValue, meta.requestKey, meta.artifactId, "raw", rep);
			}
		}
	} else {
		text = rep;
		// If a binary artifact was stored without a text representation, mark binary.
		if (text.length === 0 && meta.sizeBytes > 0) {
			// An empty text representation for a non-empty source means binary.
			const representation = represent({ bytes: sourceBytes, contentType: meta.contentType, sourcePath: meta.sourceKind === "path" ? meta.filePath : undefined }, mode);
			if (representation.kind === "binary") binary = true;
		}
	}

	if (binary) {
		const saveToResult = saveTo ? await performSaveTo(saveTo, meta, sourceBytes, env, configDir) : undefined;
		if (saveTo && saveToResult?.error) {
			warnings.push({ code: saveToResult.code ?? "save_failed", message: `${saveToResult.error}. Artifact ${meta.artifactId} remains available.` });
		}
		const base: FetchDetails = {
			ok: true,
			sourceUrl: meta.sourceUrl ?? meta.filePath ?? "",
			finalUrl: meta.finalUrl,
			...(meta.filePath ? { path: meta.filePath } : {}),
			method: meta.method,
			httpStatus: meta.httpStatus,
			contentType: meta.contentType,
			fetchedAt: meta.fetchedAt,
			artifactId: meta.artifactId,
			mode,
			sizeBytes: meta.sizeBytes,
			...(meta.sizeActual !== undefined ? { sizeActual: meta.sizeActual } : {}),
			...(meta.sizeCapped ? { sizeCapped: true } : {}),
			...(saveToResult?.savedPath ? { savedPath: saveToResult.savedPath } : {}),
			binary: true,
			warnings,
		};
		const textOut = [
			fetchHeader(meta),
			`[binary content: ${meta.contentType ?? "unknown type"}, ${meta.sizeBytes} bytes stored as artifact ${meta.artifactId}; no inline text]`,
			...(saveToResult?.savedPath ? [`[saved: ${saveToResult.savedPath}]`] : []),
			...warnings.map((w) => `[warning: ${w.message}]`),
		].join("\n");
		return { content: [{ type: "text", text: textOut }], details: base };
	}

	const totalBytes = text!.length;
	if (offset > totalBytes) {
		return fail("invalid_offset", `offset ${offset} is past the end of the served text (${totalBytes} bytes)`);
	}
	if (offset < totalBytes && isContinuationByte(text!, offset)) {
		return fail("invalid_offset", `offset ${offset} lands in the middle of a UTF-8 character`);
	}
	if (offset === totalBytes) {
		// EOF: empty successful page, no continuation (D8).
		return finishPage({
			details: {
				ok: true,
				sourceUrl: meta.sourceUrl ?? meta.filePath ?? "",
				finalUrl: meta.finalUrl,
				...(meta.filePath ? { path: meta.filePath } : {}),
				method: meta.method,
				httpStatus: meta.httpStatus,
				contentType: meta.contentType,
				fetchedAt: meta.fetchedAt,
				artifactId: meta.artifactId,
				mode,
				totalTextBytes: totalBytes,
				returnedBytes: 0,
				offset,
				endOfFile: true,
				sizeBytes: meta.sizeBytes,
				...(meta.sizeActual !== undefined ? { sizeActual: meta.sizeActual } : {}),
				warnings,
			},
			meta,
			text: "",
			endOfFile: true,
			saveToResult: undefined,
		});
	}

	const pageEnd = Math.min(offset + chunkBytes, totalBytes);
	// Never split a codepoint at the page end: if the cut byte is a UTF-8
	// continuation byte, step back to the start of that codepoint (D8).
	let end = pageEnd;
	if (end < totalBytes && isContinuationByte(text!, end)) {
		while (end > offset && isContinuationByte(text!, end - 1)) end--;
	}
	const page = text!.subarray(offset, end);
	const nextOffset = offset + page.length;
	const endOfFile = nextOffset >= totalBytes;

	const saveToResult = saveTo ? await performSaveTo(saveTo, meta, sourceBytes, env, configDir) : undefined;
	if (saveTo && saveToResult?.error) {
		// A failed save does not destroy the downloaded evidence (D5):
		// the fetch content is still served; the failure is a warning.
		warnings.push({ code: saveToResult.code ?? "save_failed", message: `${saveToResult.error}. Artifact ${meta.artifactId} remains available.` });
	}

	return finishPage({
		details: {
			ok: true,
			sourceUrl: meta.sourceUrl ?? meta.filePath ?? "",
			finalUrl: meta.finalUrl,
			...(meta.filePath ? { path: meta.filePath } : {}),
			method: meta.method,
			httpStatus: meta.httpStatus,
			contentType: meta.contentType,
			fetchedAt: meta.fetchedAt,
			artifactId: meta.artifactId,
			mode,
			totalTextBytes: totalBytes,
			returnedBytes: page.length,
			offset,
			...(endOfFile ? { endOfFile: true } : { nextOffset }),
			...(saveToResult?.savedPath ? { savedPath: saveToResult.savedPath } : {}),
			sizeBytes: meta.sizeBytes,
			...(meta.sizeActual !== undefined ? { sizeActual: meta.sizeActual } : {}),
			...(meta.sizeCapped ? { sizeCapped: true } : {}),
			warnings,
		},
		meta,
		text: page.toString("utf8"),
		endOfFile,
		nextOffset: endOfFile ? undefined : nextOffset,
		saveToResult,
	});
}

function finishPage(args: {
	details: FetchDetails;
	meta: ArtifactMeta;
	text: string;
	endOfFile?: boolean;
	nextOffset?: number;
	saveToResult?: { savedPath?: string; error?: string };
}): FetchResult {
	const lines: string[] = [fetchHeader(args.meta)];
	if (args.text.length > 0) lines.push(args.text);
	if (args.endOfFile) {
		lines.push(`[end of content: ${args.details.totalTextBytes} bytes served total]`);
	} else {
		lines.push(
			`[page: ${args.details.returnedBytes} bytes from offset ${args.details.offset} of ${args.details.totalTextBytes} total; continue with web_fetch {"artifactId": "${args.meta.artifactId}", "offset": ${args.nextOffset}}]`,
		);
	}
	if (args.saveToResult?.savedPath) {
		lines.push(`[saved: ${args.saveToResult.savedPath} (source bytes; paging artifact ${args.meta.artifactId} preserved)]`);
	}
	for (const w of args.details.warnings ?? []) {
		lines.push(`[warning: ${w.message}]`);
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: args.details };
}

function fetchHeader(meta: ArtifactMeta): string {
	const status = meta.httpStatus !== undefined ? `HTTP ${meta.httpStatus}` : "local file";
	const type = meta.contentType ?? "unknown type";
	const where = meta.sourceUrl ? `${meta.method ?? "GET"} ${meta.sourceUrl}` : `file:${meta.filePath}`;
	return `[fetch] ${where} (${status}, ${type}, ${meta.sizeBytes} bytes, ${meta.fetchedAt}) artifact=${meta.artifactId}`;
}

function isContinuationByte(text: Buffer, offset: number): boolean {
	const b = text[offset];
	return b !== undefined && b >= 0x80 && b <= 0xbf;
}

// ---------------------------------------------------------------------------
// saveTo
// ---------------------------------------------------------------------------

async function performSaveTo(
	relative: string | undefined,
	meta: ArtifactMeta,
	sourceBytes: Buffer,
	env: FetchEnvironment,
	configDir: string,
): Promise<{ savedPath?: string; error?: string; code?: "destination_blocked" | "save_failed" }> {
	return performSaveToImpl(relative, env.cwd, configDir, env.boundary, sourceBytes);
}

async function performSaveToImpl(
	relative: string | undefined,
	cwd: string,
	configDir: string,
	boundary: DatastoreBoundary,
	sourceBytes: Buffer,
): Promise<{ savedPath?: string; error?: string; code?: "destination_blocked" | "save_failed" }> {
	if (!relative) return {};
	if (path.isAbsolute(relative) || relative.startsWith("/")) {
		return { error: "saveTo must be a project-relative path", code: "destination_blocked" };
	}
	const absolute = path.resolve(cwd, relative);

	const precheck = checkDestination({
		absolute,
		projectRoot: cwd,
		configDir,
		boundary,
		exists: pathExistsSync(absolute),
		isSymlink: isSymlinkSync(absolute),
	});
	if (!precheck.ok) {
		return { error: precheck.reason ?? "destination blocked", code: "destination_blocked" };
	}

	// Create parent directories (inside the project), then write with O_EXCL.
	try {
		await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
		const handle = await open(absolute, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(sourceBytes);
		} finally {
			await handle.close();
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return { error: "destination already exists; saveTo never overwrites", code: "destination_blocked" };
		}
		return { error: `save failed: ${errMessage(err)}`, code: "save_failed" };
	}

	// Recheck the approved destination boundary at publication (D5).
	const post = await lstatSafe(absolute);
	const postcheck = checkDestination({
		absolute,
		projectRoot: cwd,
		configDir,
		boundary,
		exists: true,
		isSymlink: post?.isSymbolicLink() ?? false,
	});
	if (!postcheck.ok && postcheck.reason !== "destination already exists; saveTo never overwrites") {
		// Roll back a destination that no longer satisfies the boundary.
		await unlink(absolute).catch(() => undefined);
		return { error: postcheck.reason ?? "destination failed post-publication check", code: "destination_blocked" };
	}
	return { savedPath: relative };
}

function pathExistsSync(p: string): boolean {
	return existsSync(p);
}

function isSymlinkSync(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

async function lstatSafe(p: string) {
	try {
		return await lstat(p);
	} catch {
		return undefined;
	}
}

function positiveIntOr(value: unknown, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
	return value;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function fail(code: FetchDetails["code"], message: string): FetchResult {
	return {
		content: [{ type: "text", text: `[web_fetch failed] ${code}: ${message}` }],
		details: { ok: false, code, sourceUrl: "" },
	};
}

function executePaging(
	req: FetchRequest,
	env: FetchEnvironment,
	projectHashValue: string,
	mode: "readable" | "raw",
): Promise<FetchResult> {
	const artifactId = req.artifactId!;
	// The artifact id encodes its request key: <requestKey>-<timestamp><rand>.
	const dash = artifactId.indexOf("-");
	if (dash <= 0) return Promise.resolve(fail("artifact_error", `unknown artifactId: ${artifactId}`));
	const requestKey = artifactId.slice(0, dash);
	const id = artifactId.slice(dash + 1);
	const offset = req.offset ?? 0;
	if (offset < 0 || !Number.isSafeInteger(offset)) {
		return Promise.resolve(fail("invalid_offset", "offset must be a nonnegative safe integer byte offset"));
	}
	const cfg = env.config.config?.fetch ?? DEFAULT_CONFIG.fetch;
	const chunkBytes = positiveIntOr(req.chunkBytes, cfg.chunkBytes) ?? cfg.chunkBytes;
	const warnings: Warning[] = [];
	return (async () => {
		const meta = await readArtifactMeta(projectHashValue, requestKey, artifactId);
		if (!meta || isExpired(meta)) {
			return fail("artifact_unavailable", `artifact ${artifactId} is not available (expired, cleaned up, or unknown); start again deliberately`);
		}
		return serveFromArtifact(meta, env, projectHashValue, mode, offset, chunkBytes, warnings, req.saveTo, path.join(env.cwd, env.configDirName ?? ".pi"));
	})();
}
