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
	requestDir,
	storeRepresentation,
	type ArtifactMeta,
} from "./artifacts.ts";
import { represent } from "./extract.ts";
import { pathRequestIdentity, projectHash, urlRequestIdentity } from "./identity.ts";
import { BoundaryError, checkDestination, validateBoundary, type DatastoreBoundary } from "./policy.ts";
import { httpFetch, validateOrigin, TransportError } from "./transport.ts";
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
	if(req.refresh&&req.offset)return fail('invalid_input','refresh cannot be combined with a nonzero offset');

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
	const maxBodyBytes = hasUrl ? positiveIntOr(req.maxBodyBytes, cfg.maxBodyBytes) : cfg.maxBodyBytes;
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
				const resolved = resolveTopLevelTemplate(req.body, process.env,{cwd:env.cwd});
				if (resolved.missingEnv) {
					return fail("env_unavailable", `environment variable for {{env:${resolved.missingEnv}}} is not set`);
				}
				body = resolved.value;
				for (const w of resolved.warnings) warnings.push({ code: "template_error", message: w.message });
			}
			for (const [k, v] of Object.entries(req.headers ?? {})) {
				const resolved = resolveTopLevelTemplate(v, process.env,{cwd:env.cwd});
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
			try{await validateBoundary(env.boundary,requestDir(projectHashValue,identity.key),env.signal);}catch{if(env.signal?.aborted)throw new CancelledError();return fail('destination_blocked','Cache placement cannot be verified outside datastore roots');}
			// Storage identity is not permission to reuse an injected request.
			if (!req.refresh && (hasPath || (method==='GET'&&req.body===undefined&&!Object.keys(req.headers??{}).length))) {
				const latestId = await readLatest(projectHashValue, identity.key);
				if (latestId) {
					const meta = await readArtifactMeta(projectHashValue, identity.key, latestId);
					const reusable =
						meta &&
						!isExpired(meta) &&
						((meta.sourceKind === "path") ||
							// Automatic reuse applies only to plain GET responses (D14):
							// error bodies are not reused for a new URL-only read (D4).
							(meta.httpStatus === undefined || (meta.httpStatus>=200&&meta.httpStatus<300))&&!meta.sizeCapped);
					if (reusable) {
						return serveFromArtifact(meta!, env, projectHashValue, mode, req.offset ?? 0, chunkBytes, warnings, req.saveTo, configDir);
					}
				}
			}

			// ---- new fetch / read ----
			let meta: Omit<ArtifactMeta, "artifactId" | "fetchedAt" | "expiresAt">;
			let sourceBytes: Buffer;
			if (hasPath) {
				const read = await readLocalFile(req.filePath!, env.cwd, env.signal);
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
					if (transport.status <200 || transport.status >= 300) {
						warnings.push({ code: "http_error", message: `HTTP ${transport.status} from ${transport.finalUrl}; body retained` });
					}
				} catch (err) {
					if (err instanceof TransportError) {
						const extra=err.extra?` (${err.extra.declaredBytes!==undefined?'declared '+err.extra.declaredBytes:'read '+err.extra.bytesRead} bytes, cap ${maxBodyBytes})`:'';
						return fail(err.code,`${err.message}${extra}`,err.extra?{bytesRead:err.extra.bytesRead,capBytes:maxBodyBytes}:{});
					}
					if (err instanceof CancelledError || isCancelledError(err) || env.signal?.aborted) {
						return fail("cancelled", "fetch cancelled before completion; no artifact was published");
					}
					throw err;
				}
			}

			const published = await publishArtifact(projectHashValue, identity.key, meta, sourceBytes,{signal:env.signal,validate:absolute=>validateBoundary(env.boundary,absolute,env.signal)});
			env.signal?.throwIfAborted();
			await markLatest(projectHashValue, identity.key, published.artifactId);
			return serveFromArtifact(published, env, projectHashValue, mode, req.offset ?? 0, chunkBytes, warnings, req.saveTo, configDir);
		});
	} catch (err) {
		if(err instanceof BoundaryError)return fail('destination_blocked',err.message);
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
	cwd: string,
	signal?: AbortSignal,
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
		signal?.throwIfAborted();
		const handle = await open(absolute, "r");
		try {
			const bytes = await handle.readFile({ signal });
			signal?.throwIfAborted();
			const ext = absolute.toLowerCase().split(".").pop();
			const contentType =
				ext === "html" || ext === "htm" ? "text/html" : ext === "xml" ? "application/xml" : ext === "json" ? "application/json" : ext === "txt" || ext === "md" ? "text/plain" : undefined;
			return { bytes, absolute, contentType };
		} finally {
			await handle.close();
		}
	} catch (err) {
		signal?.throwIfAborted();
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
	if(meta.sizeCapped)return fail('artifact_unavailable','Artifact contains an incomplete prior response; start a fresh fetch');
	env.signal?.throwIfAborted();
	if(meta.sourceKind==='url'){
		if(env.config.invalid)return configInvalid(env.config.invalid);
		try{await validateOrigin(meta.sourceUrl!,env.config.config!.fetch.privateNetworks,env.lookupImpl);if(meta.finalUrl&&meta.finalUrl!==meta.sourceUrl)await validateOrigin(meta.finalUrl,env.config.config!.fetch.privateNetworks,env.lookupImpl);}catch(error){if(error instanceof TransportError)return fail(error.code,error.message);throw error;}
	}
	try{await validateBoundary(env.boundary,requestDir(projectHashValue,meta.requestKey),env.signal);}catch{if(env.signal?.aborted)throw new CancelledError();return fail('destination_blocked','Cache ownership policy unavailable or destination owned');}
	const sourceBytes = await readSourceBytes(projectHashValue, meta.requestKey, meta.artifactId);
	env.signal?.throwIfAborted();
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
				await storeRepresentation(projectHashValue, meta.requestKey, meta.artifactId, mode, rep,{signal:env.signal,validate:absolute=>validateBoundary(env.boundary,absolute,env.signal)});
			}
		} catch (err) {
			if(err instanceof BoundaryError||env.signal?.aborted)throw err;
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
				await storeRepresentation(projectHashValue, meta.requestKey, meta.artifactId, "raw", rep,{signal:env.signal,validate:absolute=>validateBoundary(env.boundary,absolute,env.signal)});
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
		const saved=saveTo?await performSaveTo(saveTo,meta,sourceBytes,env,configDir):undefined;
		if(saved?.error)warnings.push({code:saved.code??'save_failed',message:saved.error});
		// EOF remains a valid save operation on the pinned source artifact.
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
				...(saved?.savedPath?{savedPath:saved.savedPath}:{}),
				offset,
				endOfFile: true,
				sizeBytes: meta.sizeBytes,
				...(meta.sizeActual !== undefined ? { sizeActual: meta.sizeActual } : {}),
				warnings,
			},
			meta,
			text: "",
			endOfFile: true,
			saveToResult: saved,
		});
	}

	const pageEnd = Math.min(offset + chunkBytes, totalBytes);
	// Never split a codepoint at the page end: if the cut byte is a UTF-8
	// continuation byte, step back to the start of that codepoint (D8).
	let end = pageEnd;
	if (end < totalBytes && isContinuationByte(text!, end)) {
		while (end > offset && isContinuationByte(text!, end)) end--;
	}
	if(end===offset)return fail('invalid_input','chunkBytes cannot contain the next complete UTF-8 character');
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
	return performSaveToImpl(relative, env.cwd, configDir, env.boundary, sourceBytes,env.signal);
}

async function performSaveToImpl(
	relative: string | undefined,
	cwd: string,
	configDir: string,
	boundary: DatastoreBoundary,
	sourceBytes: Buffer,
	signal?:AbortSignal,
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

	const policy=async()=>{try{await validateBoundary(boundary,absolute,signal);return undefined;}catch{signal?.throwIfAborted();return {error:'Destination policy unavailable or datastore-owned',code:'destination_blocked' as const};}};
	const before=await policy();if(before)return before;
	let created=false;
	// Revalidate after directory creation, immediately before exclusive publication.
	try {
		await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
		const publication=await policy();if(publication)return publication;
		signal?.throwIfAborted();
		const handle = await open(absolute, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
		created=true;
		try {
			await handle.writeFile(sourceBytes);
			signal?.throwIfAborted();
		} finally {
			await handle.close();
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return { error: "destination already exists; saveTo never overwrites", code: "destination_blocked" };
		}
		if(created)await unlink(absolute).catch(()=>undefined);
		signal?.throwIfAborted();
		return { error: 'Save failed; cached artifact preserved', code: "save_failed" };
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

function positiveIntOr(value: unknown, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
	return value;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function fail(code: FetchDetails["code"], message: string,extra:Pick<FetchDetails,'bytesRead'|'capBytes'>={}): FetchResult {
	return {
		content: [{ type: "text", text: `[web_fetch failed] ${code}: ${message}` }],
		details: { ok: false, code, sourceUrl: "",...extra },
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
	const chunkBytes = positiveIntOr(req.chunkBytes, cfg.chunkBytes);
	if(chunkBytes===undefined||chunkBytes>CHUNK_BYTES_CEILING)return Promise.resolve(fail('invalid_input','Invalid chunkBytes page budget'));
	const warnings: Warning[] = [];
	return env.lock.run(`${projectHashValue}/${requestKey}`,env.signal,async () => {
		const meta = await readArtifactMeta(projectHashValue, requestKey, artifactId);
		if (!meta || isExpired(meta)) {
			return fail("artifact_unavailable", `artifact ${artifactId} is not available (expired, cleaned up, or unknown); start again deliberately`);
		}
		return serveFromArtifact(meta, env, projectHashValue, mode, offset, chunkBytes, warnings, req.saveTo, path.join(env.cwd, env.configDirName ?? ".pi"));
	}).catch(error=>{if(error instanceof BoundaryError)return fail('destination_blocked',error.message);if(env.signal?.aborted||error instanceof CancelledError)return fail('cancelled','Operation cancelled');throw error;});
}
