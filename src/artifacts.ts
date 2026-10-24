import { randomBytes } from "node:crypto";
import {realpathSync} from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Artifact storage (D3). Layout:
 *
 *   $TMPDIR/web-surfer/<project-hash>/<request-key>/<artifact-id>/
 *     meta.json        retrieval metadata
 *     data.bin         stored source bytes (immutable)
 *     rep-readable.bin served readable representation (lazy)
 *     rep-raw.bin      served raw representation (lazy)
 *
 *   $TMPDIR/web-surfer/<project-hash>/<request-key>/latest
 *     the artifact id currently reusable for a new same-identity read.
 *
 * Artifacts are ephemeral: protected temp namespace, 0700/0600, one-hour
 * retention with lazy expiry plus session-start cleanup. OS temp cleanup
 * before retention expiry surfaces as an unavailable artifact, never a
 * silent failure.
 */

export const RETENTION_MS = 60 * 60 * 1000;

export interface ArtifactMeta {
	artifactId: string;
	requestKey: string;
	projectHash: string;
	sourceKind: "url" | "path";
	sourceUrl?: string;
	finalUrl?: string;
	filePath?: string;
	method?: string;
	httpStatus?: number;
	contentType?: string;
	fetchedAt: string;
	expiresAt: string;
	sizeBytes: number;
	sizeActual?: number;
	sizeCapped?: boolean;
}

export function namespaceRoot(): string {
	return path.join(realpathSync(os.tmpdir()), "web-surfer");
}

export function requestDir(projectHash: string, requestKey: string): string {
	return path.join(namespaceRoot(), projectHash, requestKey);
}

export function artifactDir(projectHash: string, requestKey: string, artifactId: string): string {
	return path.join(requestDir(projectHash, requestKey), artifactId);
}

export function newArtifactId(requestKey: string): string {
	// The id embeds the request key so an artifactId alone locates its
	// storage path: <requestKey>-<timestamp36><randomhex>.
	return `${requestKey}-${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

async function protectedDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// mkdir mode is subject to umask; enforce the protected discipline.
	await chmod(dir, 0o700);
}

async function writeProtectedFile(file: string, data: Buffer | string,signal?:AbortSignal): Promise<void> {
	await writeFile(file, data, { mode: 0o600,signal });
}

/**
 * Atomically publishes a completed artifact: files land in a sibling temp
 * directory and are renamed into place, so partial downloads are never
 * exposed as ready artifacts.
 */
export async function publishArtifact(
	projectHash: string,
	requestKey: string,
	meta: Omit<ArtifactMeta, "artifactId" | "fetchedAt" | "expiresAt">,
	sourceBytes: Buffer,
	publication?:{signal?:AbortSignal;validate:(absolute:string)=>Promise<void>},
): Promise<ArtifactMeta> {
	const artifactId = newArtifactId(requestKey);
	const dir = artifactDir(projectHash, requestKey, artifactId);
	const staging = `${dir}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;

	publication?.signal?.throwIfAborted();
	await publication?.validate(dir);
	await protectedDir(requestDir(projectHash, requestKey));
	await protectedDir(staging);
	try {
		const fullMeta: ArtifactMeta = {
			...meta,
			artifactId,
			fetchedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
		};
		await writeProtectedFile(path.join(staging, "meta.json"), JSON.stringify(fullMeta, null, 2),publication?.signal);
		await writeProtectedFile(path.join(staging, "data.bin"), sourceBytes,publication?.signal);
		publication?.signal?.throwIfAborted();
		await publication?.validate(dir);
		publication?.signal?.throwIfAborted();
		await rename(staging, dir);
		return fullMeta;
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}
}

/** Records this artifact as the reusable latest for its request key. */
export async function markLatest(projectHash: string, requestKey: string, artifactId: string): Promise<void> {
	const dir = requestDir(projectHash, requestKey);
	await protectedDir(dir);
	const latest = path.join(dir, "latest");
	const tmp = `${latest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	await writeProtectedFile(tmp, artifactId);
	await rename(tmp, latest);
}

export async function readLatest(projectHash: string, requestKey: string): Promise<string | undefined> {
	try {
		const value = (await readFile(path.join(requestDir(projectHash, requestKey), "latest"), "utf8")).trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export async function readArtifactMeta(
	projectHash: string,
	requestKey: string,
	artifactId: string,
): Promise<ArtifactMeta | undefined> {
	try {
		const raw = await readFile(path.join(artifactDir(projectHash, requestKey, artifactId), "meta.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const meta = parsed as ArtifactMeta;
		if (typeof meta.artifactId !== "string" || typeof meta.expiresAt !== "string") return undefined;
		return meta;
	} catch {
		return undefined;
	}
}

export function isExpired(meta: ArtifactMeta, now = Date.now()): boolean {
	return new Date(meta.expiresAt).getTime() <= now;
}

export async function readSourceBytes(
	projectHash: string,
	requestKey: string,
	artifactId: string,
): Promise<Buffer | undefined> {
	try {
		return await readFile(path.join(artifactDir(projectHash, requestKey, artifactId), "data.bin"));
	} catch {
		return undefined;
	}
}

export async function readRepresentation(
	projectHash: string,
	requestKey: string,
	artifactId: string,
	mode: "readable" | "raw",
): Promise<Buffer | undefined> {
	try {
		return await readFile(
			path.join(
				artifactDir(projectHash, requestKey, artifactId),
				mode === "readable" ? "rep-readable.bin" : "rep-raw.bin",
			),
		);
	} catch {
		return undefined;
	}
}

export async function storeRepresentation(
	projectHash: string,
	requestKey: string,
	artifactId: string,
	mode: "readable" | "raw",
	text: Buffer,
	publication?:{signal?:AbortSignal;validate:(absolute:string)=>Promise<void>},
): Promise<void> {
	const dir = artifactDir(projectHash, requestKey, artifactId);
	const target=path.join(dir,mode==='readable'?'rep-readable.bin':'rep-raw.bin');
	const staging=target+'.tmp-'+randomBytes(4).toString('hex');
	try{publication?.signal?.throwIfAborted();await publication?.validate(target);await writeProtectedFile(staging,text,publication?.signal);publication?.signal?.throwIfAborted();await publication?.validate(target);publication?.signal?.throwIfAborted();await rename(staging,target);}finally{await rm(staging,{force:true});}
}

/**
 * Removes only this package's expired artifacts. Walks the project's own
 * namespace; never touches other projects' data.
 */
export async function cleanupExpired(projectHash: string): Promise<number> {
	const projectDir = path.join(namespaceRoot(), projectHash);
	let removed = 0;
	let requestKeys: string[] = [];
	try {
		requestKeys = await readdir(projectDir);
	} catch {
		return 0;
	}
	for (const requestKey of requestKeys) {
		const reqDir = path.join(projectDir, requestKey);
		let entries: string[] = [];
		try {
			entries = await readdir(reqDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry === "latest") continue;
			const meta = await readArtifactMeta(projectHash, requestKey, entry);
			if (!meta || isExpired(meta)) {
				await rm(path.join(reqDir, entry), { recursive: true, force: true });
				removed++;
			}
		}
	}
	return removed;
}

function makeCancelledError(): Error & { code: string } {
	const err = new Error("cancelled") as Error & { code: string };
	err.code = "cancelled";
	return err;
}

export function isCancelledError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "cancelled";
}

export class CancelledError extends Error {
	constructor() {
		super("cancelled");
		this.name = "CancelledError";
	}
}

/**
 * In-process per-key coordination: operations on the same request key are
 * serialized so publication and reuse decisions cannot race. Cancellation
 * ownership stays with each caller — an already-aborted caller fails
 * immediately instead of waiting on the lock.
 */
export class KeyLock {
	private tails = new Map<string, Promise<void>>();

	async run<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		if (signal?.aborted) throw new CancelledError();
		const prev = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const tail = prev.then(() => gate);
		this.tails.set(key, tail);
		await prev;
		if (signal?.aborted) {
			release();
			throw new CancelledError();
		}
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

export { makeCancelledError };
