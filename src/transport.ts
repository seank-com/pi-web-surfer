import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { FetchConfig } from "./config.ts";
import type { ClientRequestArgs } from "node:http";
import type { Duplex } from "node:stream";

/**
 * HTTP/HTTPS transport (D13, D14 reconciliation).
 *
 * Origin policy: under `privateNetworks: "deny"`, the policy check runs inside
 * the connection the request uses. A custom createConnection factory resolves
 * the destination, validates every resolved address (literal IP hosts use the
 * same path), and connects to a validated address — so the checked and
 * connected addresses cannot diverge. In allow mode Node's default connection
 * behavior is kept untouched.
 *
 * Redirects: all hops share the attempt budget. Same-origin redirects forward
 * method, body, and headers; cross-origin redirects re-issue as a GET with no
 * body and no headers, so environment-injected credentials and spliced file
 * content never follow a redirect to a different origin.
 *
 * Body caps: a declared Content-Length above the cap is rejected before
 * reading; the cap is also enforced on the decoded stream so compressed bodies
 * cannot expand beyond it unnoticed.
 */

export class TransportError extends Error {
	readonly code:
		| "blocked_origin"
		| "dns_failed"
		| "connection_failed"
		| "timeout"
		| "size_exceeded"
		| "unsupported_scheme"
		| "refused_redirect"
		| "redirect_limit"
		| "malformed_url";
	readonly extra?: { declaredBytes?: number; bytesRead?: number };

	constructor(
		message: string,
		code:
			| "blocked_origin"
			| "dns_failed"
			| "connection_failed"
			| "timeout"
			| "size_exceeded"
			| "unsupported_scheme"
			| "refused_redirect"
			| "redirect_limit"
			| "malformed_url",
		extra?: { declaredBytes?: number; bytesRead?: number },
	) {
		super(message);
		this.name = "TransportError";
		this.code = code;
		this.extra = extra;
	}
}

export interface TransportResult {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	finalUrl: string;
	sizeActual?: number;
	sizeCapped?: boolean;
}

export interface TransportOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	config: FetchConfig;
	signal?: AbortSignal;
	/** Test seam: DNS override for the policy lookup. */
	lookupImpl?: (hostname: string) => Promise<string[]>;
}

const PRIVATE_RANGES: Array<(ip: string) => boolean> = [
	(ip) => ip === "0.0.0.0" || ip.startsWith("127."),
	(ip) => ip.startsWith("10."),
	(ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
	(ip) => ip.startsWith("192.168."),
	(ip) => ip.startsWith("169.254."),
	(ip) => ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:1",
	(ip) => /^f[cd][0-9a-f]{2}:/i.test(ip),
	(ip) => /^fe80:/i.test(ip),
	(ip) => /^fc00:/i.test(ip),
];

export function isPrivateAddress(ip: string): boolean {
	return PRIVATE_RANGES.some((fn) => fn(ip.toLowerCase()));
}

export interface PolicyDescriptor {
	mode: "allow" | "deny";
	/** Test seam: DNS override for the policy resolution. */
	lookupImpl?: (hostname: string) => Promise<string[]>;
}

type OnCreate = (err: Error | null, socket: Duplex) => void;
type PolicyConnectionFactory = (options: ClientRequestArgs, oncreate: OnCreate) => Duplex | null | undefined;

/**
 * Builds the Node createConnection factory that enforces the origin policy in
 * the connection path (D13). Node never invokes a `lookup` option on
 * http.request and skips lookup entirely for literal IP hosts, so the check
 * lives here: the factory resolves the destination, validates every address,
 * and connects to a validated address — checked and connected addresses are
 * one. Returns undefined in allow mode so Node keeps its default behavior.
 */
function makePolicyConnection(
	policy: PolicyDescriptor | undefined,
	isHttps: boolean,
): PolicyConnectionFactory | undefined {
	if (!policy || policy.mode !== "deny") return undefined;
	const { lookupImpl } = policy;
	return (options: ClientRequestArgs, oncreate: OnCreate) => {
		const host = options.hostname ?? options.host;
		if (!host) {
			oncreate(new TransportError("no host for policy check", "malformed_url"), null as unknown as Duplex);
			return;
		}
		const connectTo = (address: string, family: number) => {
			const target = { ...options, host: address, lookup: undefined, family };
			const socket = isHttps ? tls.connect(target as never) : net.connect(target as never);
			oncreate(null, socket as Duplex);
		};
		try {
			if (net.isIP(host)) {
				if (isPrivateAddress(host)) {
					throw new TransportError(`origin policy denies private address: ${host}`, "blocked_origin");
				}
				connectTo(host, net.isIP(host) === 6 ? 6 : 4);
			} else {
				const resolved = lookupImpl
					? lookupImpl(host)
					: dns.promises.lookup(host, { all: true }).then((a) => a.map((x) => x.address));
				resolved
					.then((addresses) => {
						if (addresses.length === 0) {
							throw new TransportError(`no addresses for host ${host}`, "dns_failed");
						}
						if (addresses.some((a) => isPrivateAddress(a))) {
							throw new TransportError("origin policy denies private address for host", "blocked_origin");
						}
						connectTo(addresses[0]!, 4);
					})
					.catch((err) => oncreate(err as Error, null as unknown as Duplex));
			}
		} catch (err) {
			oncreate(err as Error, null as unknown as Duplex);
		}
		return undefined;
	};
}

function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.host === b.host;
}

function hostOf(u: URL): string {
	return u.host;
}

export async function httpFetch(opts: TransportOptions): Promise<TransportResult> {
	const startedAt = Date.now();
	const totalBudgetMs = opts.config.timeoutMs;
	const deadline = startedAt + totalBudgetMs;

	let currentUrl = new URL(opts.url);
	let method = (opts.method ?? "GET").toUpperCase();
	let headers: Record<string, string> = { ...opts.headers };
	let body = opts.body;

	const policy: PolicyDescriptor = { mode: opts.config.privateNetworks, lookupImpl: opts.lookupImpl };

	for (let hop = 0; ; hop++) {
		validateScheme(currentUrl);
		if (opts.signal?.aborted) throw new TransportError("cancelled", "timeout");

		const result = await singleRequest({
			url: currentUrl,
			method,
			headers,
			body,
			config: opts.config,
			signal: opts.signal,
			policy,
			deadline,
		});

		const isRedirect = [301, 302, 303, 307, 308].includes(result.status);
		if (!isRedirect) return { ...result, finalUrl: currentUrl.toString() };
		const location = result.headers["location"];
		if (!location) return { ...result, finalUrl: currentUrl.toString() };
		if (hop + 1 > opts.config.maxRedirects) {
			throw new TransportError(`too many redirects (limit ${opts.config.maxRedirects})`, "redirect_limit");
		}
		let next: URL;
		try {
			next = new URL(location, currentUrl);
		} catch {
			throw new TransportError("malformed redirect location", "refused_redirect");
		}
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			throw new TransportError(`redirect to unsupported scheme: ${next.protocol}`, "unsupported_scheme");
		}

		// Forwarding rules (D14 reconciliation):
		//  - 303 always becomes GET with no body.
		//  - same-origin: keep method, body, headers.
		//  - cross-origin: GET, no body, no headers.
		const isSame = sameOrigin(currentUrl, next);
		if (result.status === 303 || !isSame) {
			method = "GET";
			body = undefined;
			headers = {};
		} else {
			// strip hop-specific headers
			for (const k of Object.keys(headers)) {
				if (["host", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase())) {
					delete headers[k];
				}
			}
		}
		currentUrl = next;
	}
}

function validateScheme(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TransportError(`unsupported scheme: ${url.protocol}`, "unsupported_scheme");
	}
}

interface SingleRequestOptions {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body?: string;
	config: FetchConfig;
	signal?: AbortSignal;
	policy?: PolicyDescriptor;
	deadline: number;
}

async function singleRequest(opts: SingleRequestOptions): Promise<TransportResult> {
	const { url, config, deadline } = opts;
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new TransportError("fetch attempt exceeded total budget", "timeout");

	const isHttps = url.protocol === "https:";
	const lib = isHttps ? https : http;
	const bodyBuffer = opts.body !== undefined ? Buffer.from(opts.body, "utf8") : undefined;
	const createConnection = makePolicyConnection(opts.policy, isHttps);

	const headers: Record<string, string> = {
		accept: "*/*",
		...opts.headers,
	};
	if (bodyBuffer) headers["content-length"] = String(bodyBuffer.length);

	return new Promise<TransportResult>((resolve, reject) => {
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			req.destroy();
			reject(err);
		};

		const req = lib.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method: opts.method,
				headers,
				timeout: Math.min(config.connectTimeoutMs, remaining),
				...(createConnection ? { createConnection } : {}),
			},
			(res) => {
				const status = res.statusCode ?? 0;
				const respHeaders: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (Array.isArray(v)) respHeaders[k.toLowerCase()] = v.join(", ");
					else if (v !== undefined) respHeaders[k.toLowerCase()] = v;
				}

				const declared = Number(respHeaders["content-length"]);
				if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
					res.destroy();
					fail(new TransportError(`declared Content-Length ${declared} exceeds cap ${config.maxBodyBytes}`, "size_exceeded", { declaredBytes: declared }));
					return;
				}

				const chunks: Buffer[] = [];
				let total = 0;
				const encoding = (respHeaders["content-encoding"] ?? "").toLowerCase();

				res.on("data", (chunk: Buffer) => {
					total += chunk.length;
					// Cap on encoded bytes as a first line; decoded cap enforced below.
					if (total > config.maxBodyBytes * 8 + 65536) {
						fail(new TransportError(`response exceeds body cap`, "size_exceeded", { bytesRead: total }));
						res.destroy();
						return;
					}
					chunks.push(chunk);
				});
				res.on("error", (err) => fail(mapSocketError(err)));
				res.on("end", () => {
					const encoded = Buffer.concat(chunks);
					void decodeBody(encoded, encoding, config.maxBodyBytes)
						.then((decoded) => {
							if (settled) return;
							settled = true;
							resolve({
								status,
								headers: respHeaders,
								body: decoded.bytes,
								finalUrl: url.toString(),
								sizeActual: Number.isFinite(declared) ? declared : decoded.bytes.length,
								sizeCapped: decoded.capped,
							});
						})
						.catch(fail);
				});
			},
		);

		req.on("timeout", () => fail(new TransportError("connect or response timeout", "timeout")));
		req.on("error", (err: NodeJS.ErrnoException) => {
			if (opts.signal?.aborted) return fail(new TransportError("cancelled", "timeout"));
			if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ENETUNREACH") {
				return fail(new TransportError(`connection failed: ${err.code}`, "connection_failed"));
			}
			if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
				return fail(new TransportError(`dns lookup failed: ${err.code}`, "dns_failed"));
			}
			if (err instanceof TransportError) return fail(err);
			fail(mapSocketError(err));
		});

		const onAbort = () => fail(new TransportError("cancelled", "timeout"));
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));

		if (bodyBuffer) req.write(bodyBuffer);
		req.end();
	});
}

async function decodeBody(
	encoded: Buffer,
	encoding: string,
	maxBytes: number,
): Promise<{ bytes: Buffer; capped: boolean }> {
	const decode = async (): Promise<Buffer> => {
		if (encoding.includes("gzip")) return gunzipSync(encoded);
		if (encoding.includes("deflate")) return inflateSync(encoded);
		if (encoding.includes("br")) return brotliDecompressSync(encoded);
		return encoded;
	};
	try {
		const decoded = await decode();
		if (decoded.length > maxBytes) {
			return { bytes: decoded.subarray(0, maxBytes), capped: true };
		}
		return { bytes: decoded, capped: false };
	} catch {
		// Undecodable compressed body: serve encoded bytes, never invent content.
		if (encoded.length > maxBytes) {
			return { bytes: encoded.subarray(0, maxBytes), capped: true };
		}
		return { bytes: encoded, capped: false };
	}
}

function mapSocketError(err: Error): TransportError {
	if (err instanceof TransportError) return err;
	if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
		return new TransportError("connection failed: ECONNREFUSED", "connection_failed");
	}
	return new TransportError(`request failed: ${err.message}`, "connection_failed");
}

export { hostOf };
