import path from "node:path";
import { randomUUID } from "node:crypto";
/** Narrow consumption of the documented datastore v1 capability/RPC contract. */
export const CAPABILITY_REQUEST = "pi-markdown-datastore:v1:capability-request";
export const CAPABILITY_REPLY = "pi-markdown-datastore:v1:capability-reply";
export const POLICY_REQUEST = "pi-markdown-datastore:v1:request";
export interface EventBusLike {
	emit(type: string, data: unknown): void;
	on(type: string, handler: (data: any) => void): () => void;
}
export interface DatastoreBoundary {
	available: boolean;
	roots: string[];
	reason?: string;
	validate?: (absolute: string, signal?: AbortSignal) => Promise<void>;
}
export function discoverDatastoreBoundary(
	bus: EventBusLike | undefined,
	_cwd?: string,
	_configDirName?: string,
): DatastoreBoundary {
	const capability = () => {
		if (!bus) throw new Error("Datastore policy service unavailable");
		const requestId = randomUUID();
		const replies: any[] = [];
		const off = bus.on(CAPABILITY_REPLY, (r) => {
			if (r?.requestId === requestId) replies.push(r);
		});
		try {
			bus.emit(CAPABILITY_REQUEST, { version: 1, requestId });
		} finally {
			off();
		}
		const c = replies[0]?.capability;
		if (
			replies.length !== 1 ||
			c?.version !== 1 ||
			c.contractVersion !== 1 ||
			!c.ready ||
			c.policyVersion !== 1 ||
			typeof c.instanceId !== "string"
		)
			throw new Error("Datastore policy service unavailable or incompatible");
		return c;
	};
	const request = (instanceId: string, operation: string, input: unknown, signal?: AbortSignal): Promise<any> =>
		new Promise((resolve, reject) => {
			if (!bus) return reject(new Error("Datastore policy unavailable"));
			let settled = false;
			const finish = (error: unknown, result?: any) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else if (result?.contractVersion !== 1 || result.operation !== operation)
					reject(new Error("Invalid datastore policy response"));
				else resolve(result.data);
			};
			const abort = () => finish(new Error("Datastore policy request cancelled"));
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			// The datastore's documented RPC default is 15 minutes; its service owns enforcement.
			// This adapter installs no timer or HTTP/search timeout. Caller/session abort propagates.
			try {
				bus.emit(POLICY_REQUEST, {
					contractVersion: 1,
					requestId: randomUUID(),
					instanceId,
					request: { operation, input },
					deadline: Date.now() + 900_000,
					signal,
					resolve: (result: any) => finish(undefined, result),
					reject: (error: unknown) => finish(error),
				});
			} catch (error) {
				finish(error);
			}
		});
	return {
		get available() {
			try {
				capability();
				return true;
			} catch {
				return false;
			}
		},
		roots: [],
		reason: "Datastore policy service unavailable or incompatible",
		async validate(absolute, signal) {
			const c = capability();
			const roots = await request(c.instanceId, "roots", {}, signal);
			if (!Array.isArray(roots?.roots)) throw new Error("Invalid datastore roots response");
			const destination = await request(c.instanceId, "validateDestination", { path: absolute }, signal);
			if (destination?.path !== absolute || typeof destination.owned !== "boolean")
				throw new Error("Invalid datastore destination response");
			if (destination.owned) throw new Error("Destination belongs to a datastore");
		},
	};
}
export class BoundaryError extends Error {}
export async function validateBoundary(
	boundary: DatastoreBoundary,
	absolute: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		signal?.throwIfAborted();
		if (!boundary.available) throw new Error();
		if (boundary.validate) await boundary.validate(absolute, signal);
		else if (boundary.roots.some((root) => inside(absolute, root))) throw new Error();
		signal?.throwIfAborted();
	} catch {
		signal?.throwIfAborted();
		throw new BoundaryError("Datastore policy unavailable or destination owned");
	}
}
export interface DestinationCheck {
	ok: boolean;
	code?: "destination_blocked" | "save_failed";
	reason?: string;
}
export function checkDestination(opts: {
	absolute: string;
	projectRoot: string;
	configDir: string;
	boundary: DatastoreBoundary;
	exists: boolean;
	isSymlink: boolean;
}): DestinationCheck {
	const denied = (reason: string): DestinationCheck => ({ ok: false, code: "destination_blocked", reason });
	if (opts.isSymlink) return denied("destination must not be a symlink");
	if (opts.exists) return denied("destination already exists; saveTo never overwrites");
	if (!inside(opts.absolute, opts.projectRoot)) return denied("destination is outside the project");
	if (inside(opts.absolute, opts.configDir))
		return denied("destination is inside the protected configuration directory");
	if (!opts.boundary.available) return denied("datastore boundary unavailable");
	if (opts.boundary.roots.some((root) => inside(opts.absolute, root)))
		return denied("destination is inside a datastore root");
	return { ok: true };
}
function inside(candidate: string, parent: string): boolean {
	const rel = path.relative(parent, candidate);
	return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
