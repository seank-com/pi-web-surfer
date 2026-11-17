import path from "node:path";
import { randomUUID } from "node:crypto";
/** Narrow consumption of the documented datastore v1 capability/RPC contract. */
export const CAPABILITY_REQUEST = "pi-markdown-datastore:v1:capability-request";
export const CAPABILITY_REPLY = "pi-markdown-datastore:v1:capability-reply";
export const POLICY_REQUEST = "pi-markdown-datastore:v1:request";

/** Absent companion, ready protection, or a reply that cannot be used. */
export type ProtectionMode = "absent" | "ready" | "incompatible";

export interface EventBusLike {
	emit(type: string, data: unknown): void;
	on(type: string, handler: (data: any) => void): () => void;
}
export interface DatastoreBoundary {
	/** Legacy flag: true only when a ready policy-v1 instance was discovered. */
	available: boolean;
	roots: string[];
	mode?: ProtectionMode;
	reason?: string;
	warning?: string;
	validate?: (absolute: string, signal?: AbortSignal) => Promise<void>;
	/** Fresh public discovery. Call after companion session_start, and again before publication. */
	inspect?: (signal?: AbortSignal) => Promise<{ mode: ProtectionMode; warning?: string }>;
}

interface Classification {
	mode: ProtectionMode;
	instanceId?: string;
	warning?: string;
	needsPolicyError?: boolean;
}

function classifyReplies(replies: any[]): Classification {
	if (replies.length === 0) return { mode: "absent" };
	if (replies.length !== 1) {
		return {
			mode: "incompatible",
			warning:
				"Datastore policy discovery returned multiple replies. Exports are blocked until exactly one compatible companion is running.",
		};
	}
	const c = replies[0]?.capability;
	const wellFormed =
		c?.version === 1 &&
		c.contractVersion === 1 &&
		typeof c.ready === "boolean" &&
		Array.isArray(c.stores);
	if (!wellFormed) {
		return {
			mode: "incompatible",
			warning:
				"Datastore policy discovery returned an incompatible reply. Exports are blocked until the companion contract is corrected.",
		};
	}
	if (c.policyVersion === 1 && typeof c.instanceId === "string" && c.instanceId.length > 0) {
		return { mode: c.ready ? "ready" : "absent", instanceId: c.instanceId, needsPolicyError: !c.ready };
	}
	return {
		mode: "incompatible",
		warning:
			"Datastore policy discovery does not offer policy contract version 1. Exports are blocked until that contract is available.",
	};
}

export function discoverDatastoreBoundary(
	bus: EventBusLike | undefined,
	_cwd?: string,
	_configDirName?: string,
): DatastoreBoundary {
	const classify = (): Classification => {
		if (!bus) return { mode: "absent" };
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
		return classifyReplies(replies);
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
			// The datastore's documented RPC envelope requires a deadline. Its service owns enforcement.
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
	const policyCode = (error: unknown): string | undefined =>
		error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
	const inspect = async (signal?: AbortSignal): Promise<{ mode: ProtectionMode; warning?: string }> => {
		signal?.throwIfAborted();
		const found = classify();
		if (!found.needsPolicyError || !found.instanceId) return { mode: found.mode, warning: found.warning };
		try {
			await request(found.instanceId, "roots", {}, signal);
			return {
				mode: "incompatible",
				warning: "Datastore policy replied ready:false but roots succeeded. Exports are blocked until that contradiction is corrected.",
			};
		} catch (error) {
			signal?.throwIfAborted();
			const code = policyCode(error);
			if (code === "CONFIG_MISSING") return { mode: "absent" };
			const shown = code ?? "unavailable";
			return {
				mode: "incompatible",
				warning: `Datastore protection failed (${shown}). Exports are blocked until that configuration is corrected.`,
			};
		}
	};
	return {
		roots: [],
		inspect,
		get available() {
			return false;
		},
		async validate(absolute, signal) {
			const found = await inspect(signal);
			if (found.mode === "absent") return;
			if (found.mode !== "ready") throw new Error(found.warning ?? "Datastore policy unavailable");
			const current = classify();
			if (!current.instanceId) throw new Error("Datastore policy instance is no longer available");
			let roots: any;
			try {
				roots = await request(current.instanceId, "roots", {}, signal);
			} catch (error) {
				if (policyCode(error) === "CONFIG_MISSING") return;
				throw new Error(`Datastore protection failed (${policyCode(error) ?? "unavailable"}).`);
			}
			if (!Array.isArray(roots?.roots)) throw new Error("Invalid datastore roots response");
			let destination: any;
			try {
				destination = await request(current.instanceId, "validateDestination", { path: absolute }, signal);
			} catch (error) {
				if (policyCode(error) === "CONFIG_MISSING") return;
				throw new Error(`Datastore protection failed (${policyCode(error) ?? "unavailable"}).`);
			}
			if (destination?.path !== absolute || typeof destination.owned !== "boolean")
				throw new Error("Invalid datastore destination response");
			if (destination.owned) throw new Error("Destination belongs to a datastore");
		},
	};
}

export class BoundaryError extends Error {}

export function protectionMode(boundary: DatastoreBoundary): ProtectionMode {
	if (boundary.mode) return boundary.mode;
	return boundary.available ? "ready" : "incompatible";
}

export async function validateBoundary(
	boundary: DatastoreBoundary,
	absolute: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		signal?.throwIfAborted();
		if (boundary.inspect) {
			await boundary.validate?.(absolute, signal);
			signal?.throwIfAborted();
			return;
		}
		const mode = protectionMode(boundary);
		if (mode === "absent") return;
		if (mode !== "ready") throw new Error(boundary.warning ?? boundary.reason ?? "Datastore policy unavailable");
		if (boundary.validate) await boundary.validate(absolute, signal);
		else if (boundary.roots.some((root) => inside(absolute, root))) throw new Error("Destination belongs to a datastore");
		signal?.throwIfAborted();
	} catch (error) {
		signal?.throwIfAborted();
		throw new BoundaryError(error instanceof Error && error.message ? error.message : "Datastore policy unavailable or destination owned");
	}
}

export interface DestinationCheck {
	ok: boolean;
	code?: "destination_blocked" | "save_failed";
	reason?: string;
}
export function checkDestination(opts: {
	absolute: string;
	downloadsRoot: string;
	configDir: string;
	boundary: DatastoreBoundary;
	exists: boolean;
	isSymlink: boolean;
}): DestinationCheck {
	const denied = (reason: string): DestinationCheck => ({ ok: false, code: "destination_blocked", reason });
	if (opts.isSymlink) return denied("destination must not be a symlink");
	if (opts.exists) return denied("destination already exists; saveTo never overwrites");
	if (!inside(opts.absolute, opts.downloadsRoot)) return denied("destination is outside the downloads directory");
	if (inside(opts.absolute, opts.configDir))
		return denied("destination is inside the protected configuration directory");
	const mode = opts.boundary.inspect ? undefined : protectionMode(opts.boundary);
	if (mode && mode !== "absent" && mode !== "ready") {
		return denied(opts.boundary.warning ?? opts.boundary.reason ?? "datastore protection is not usable");
	}
	if (mode === "ready" && opts.boundary.roots.some((root) => inside(opts.absolute, root)))
		return denied("destination is inside a datastore root");
	return { ok: true };
}
function inside(candidate: string, parent: string): boolean {
	const rel = path.relative(parent, candidate);
	return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
