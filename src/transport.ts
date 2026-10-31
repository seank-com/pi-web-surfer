import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector } from "undici";
import type { FetchConfig } from "./config.ts";

export class TransportError extends Error {
	readonly code: string;
	readonly extra?: { declaredBytes?: number; bytesRead?: number };
	constructor(message: string, code: string, extra?: { declaredBytes?: number; bytesRead?: number }) {
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
	lookupImpl?: (hostname: string) => Promise<string[]>;
	fetchImpl?: typeof fetch;
}

export function isPrivateAddress(address: string): boolean {
	const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (net.isIPv4(ip))
		return (
			ip.startsWith("127.") ||
			ip.startsWith("10.") ||
			ip.startsWith("192.168.") ||
			ip.startsWith("169.254.") ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
			ip.startsWith("0.")
		);
	if (!net.isIPv6(ip)) return true;
	// URL canonicalization handles expanded IPv6 and dotted IPv4-mapped forms.
	const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	if (canonical.startsWith("::ffff:")) {
		const words = canonical.slice(7).split(":");
		const n = (parseInt(words[0]!, 16) * 65536 + parseInt(words[1]!, 16)) >>> 0;
		return isPrivateAddress(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
	}
	return canonical === "::" || canonical === "::1" || /^(fc|fd)/.test(canonical) || /^fe[89ab]/.test(canonical);
}
function parsed(value: string): URL {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol))
			throw new TransportError("Only HTTP(S) URLs are supported", "unsupported_scheme");
		return url;
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw new TransportError("Invalid HTTP(S) URL", "malformed_url");
	}
}
function hostname(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "");
}
async function addresses(host: string, lookup?: TransportOptions["lookupImpl"]): Promise<string[]> {
	if (net.isIP(host)) return [host];
	try {
		const result = lookup ? await lookup(host) : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
		if (!result.length || result.some((a) => !net.isIP(a))) throw new Error();
		return result;
	} catch {
		throw new TransportError("DNS lookup failed", "dns_failed");
	}
}
function checked(values: string[]): string[] {
	if (values.some(isPrivateAddress)) throw new TransportError("Origin policy denies private address", "blocked_origin");
	return values;
}
/** Cached reads have no connection; check their recorded origins against current policy. */
export async function validateOrigin(
	value: string,
	mode: "allow" | "deny",
	lookup?: TransportOptions["lookupImpl"],
): Promise<void> {
	const url = parsed(value);
	if (mode === "deny") checked(await addresses(hostname(url), lookup));
}
/** A single checked lookup supplies the addresses used by Undici's standard connector. */
function denyAgent(lookup?: TransportOptions["lookupImpl"]): Agent {
	const connector = buildConnector({
		lookup: ((host: string, options: any, callback: any) => {
			void addresses(host, lookup)
				.then(checked)
				.then((values) => {
					const all = values.map((address) => ({ address, family: net.isIP(address) }));
					if (options.all) callback(null, all);
					else callback(null, all[0]!.address, all[0]!.family);
				})
				.catch((error) => callback(error));
		}) as typeof dns.lookup,
	});
	return new Agent({
		connect: (options, callback) => {
			const host = options.hostname.replace(/^\[|\]$/g, "");
			if (net.isIP(host) && isPrivateAddress(host)) {
				callback(new TransportError("Origin policy denies private address", "blocked_origin"), null);
				return;
			}
			connector(options, callback);
		},
	});
}
export async function readResponseBody(response: Response, cap: number, signal?: AbortSignal): Promise<Buffer> {
	const declared = Number(response.headers.get("content-length"));
	if (response.headers.has("content-length") && Number.isFinite(declared) && declared > cap) {
		await response.body?.cancel();
		throw new TransportError("Declared response length exceeds body cap", "size_exceeded", { declaredBytes: declared });
	}
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let total = 0;
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			total += value.length;
			if (total > cap)
				throw new TransportError("Decoded response exceeds body cap", "size_exceeded", { bytesRead: total });
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks, total);
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
export async function httpFetch(opts: TransportOptions): Promise<TransportResult> {
	let url = parsed(opts.url);
	let method = opts.method ?? "GET";
	let body = opts.body;
	let headers = { ...opts.headers };
	const dispatcher = opts.config.privateNetworks === "deny" ? denyAgent(opts.lookupImpl) : undefined;
	try {
		for (let hop = 0; ; hop++) {
			opts.signal?.throwIfAborted();
			if (opts.config.privateNetworks === "deny" && net.isIP(hostname(url))) checked([hostname(url)]);
			const init: RequestInit & { dispatcher?: Agent } = {
				method,
				headers,
				body,
				redirect: "manual",
				signal: opts.signal,
				...(dispatcher ? { dispatcher } : {}),
			};
			const response = await (opts.fetchImpl ?? fetch)(url, init);
			const location = response.headers.get("location");
			if ([301, 302, 303, 307, 308].includes(response.status) && location) {
				await response.body?.cancel();
				if (hop >= opts.config.maxRedirects) throw new TransportError("Redirect limit exceeded", "redirect_limit");
				let next: URL;
				try {
					next = parsed(new URL(location, url).href);
				} catch (error) {
					if (error instanceof TransportError) throw error;
					throw new TransportError("Invalid redirect destination", "refused_redirect");
				}
				if (url.origin !== next.origin) {
					method = "GET";
					body = undefined;
					headers = {};
				}
				url = next;
				continue;
			}
			const bytes = await readResponseBody(response, opts.config.maxBodyBytes, opts.signal);
			return {
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: bytes,
				finalUrl: url.href,
				sizeActual: bytes.length,
			};
		}
	} catch (error) {
		if (opts.signal?.aborted) throw new TransportError("Request cancelled", "cancelled");
		if (error instanceof TransportError) throw error;
		const cause = (error as { cause?: unknown })?.cause;
		if (cause instanceof TransportError) throw cause;
		throw new TransportError("HTTP request failed", "connection_failed");
	} finally {
		if (dispatcher) await dispatcher.destroy();
	}
}
export function hostOf(url: URL): string {
	return url.host;
}
