import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Datastore root/policy boundary (D1, decided 2026-10-20).
 *
 * The architectural choice is closed: an authoritative root-enumeration and
 * destination-validation API owned by pi-markdown-datastore (issue #6).
 * Until that API exists, this module:
 *
 *   - asks for the capability over the established extension event bus
 *     (capability-request/reply pattern, v1);
 *   - if no responder is present but a datastore configuration exists for
 *     this project, reports the boundary as unavailable so save publication
 *     fails closed rather than guessing;
 *   - if no datastore is configured, reports an empty (authoritative) root
 *     set: there is nothing to stay outside of.
 *
 * web-surfer never infers roots from configuration files, copies the
 * datastore's private loader or containment algorithms, or treats a redacted
 * model-facing status path as a canonical root.
 */

export interface DatastoreBoundary {
	/** True when the root set is authoritative for this project. */
	available: boolean;
	/** Canonical, resolved store roots (empty when no datastore is configured). */
	roots: string[];
	/** Present when a datastore is configured but no API responder answered. */
	reason?: string;
}

export interface EventBusLike {
	emit(type: string, data: unknown): void;
	on(type: string, handler: (data: unknown) => void): () => void;
}

export const BOUNDARY_REQUEST = "pi-markdown-datastore:v1:boundary-request";
export const BOUNDARY_REPLY = "pi-markdown-datastore:v1:boundary-reply";

interface BoundaryReply {
	version: number;
	requestId: string;
	roots: string[];
}

const BOUNDARY_TIMEOUT_MS = 500;

/**
 * Discovers the datastore boundary for a project. Must be called after
 * session start (responder extensions are registered by then).
 */
export async function discoverDatastoreBoundary(
	bus: EventBusLike | undefined,
	cwd: string,
	configDirName = ".pi",
): Promise<DatastoreBoundary> {
	const datastoreConfigured = existsSync(path.join(cwd, configDirName, "markdown-datastore", "config.json"));

	if (bus) {
		const requestId = randomUUID();
		const reply = await new Promise<BoundaryReply | undefined>((resolve) => {
			const timer = setTimeout(() => {
				unsub();
				resolve(undefined);
			}, BOUNDARY_TIMEOUT_MS);
			const unsub = bus.on(BOUNDARY_REPLY, (data: unknown) => {
				const d = data as BoundaryReply;
				if (d && d.version === 1 && d.requestId === requestId && Array.isArray(d.roots)) {
					clearTimeout(timer);
					unsub();
					resolve(d);
				}
			});
			bus.emit(BOUNDARY_REQUEST, { version: 1, requestId });
		});
		if (reply) {
			return { available: true, roots: reply.roots.map((r) => path.resolve(r)) };
		}
	}

	if (datastoreConfigured) {
		return {
			available: false,
			roots: [],
			reason: "datastore configured for this project but no root/policy API responder is available",
		};
	}
	return { available: true, roots: [] };
}

export interface DestinationCheck {
	ok: boolean;
	code?: "destination_blocked" | "save_failed";
	reason?: string;
}

/**
 * Validates a saveTo destination (D5, D3): inside the project, outside the
 * protected configuration directory, outside datastore roots, and not an
 * existing file. The check is re-run at publication.
 */
export function checkDestination(opts: {
	absolute: string;
	projectRoot: string;
	configDir: string;
	boundary: DatastoreBoundary;
	exists: boolean;
	isSymlink: boolean;
}): DestinationCheck {
	const { absolute, projectRoot, configDir, boundary } = opts;
	if (opts.isSymlink) {
		return { ok: false, code: "destination_blocked", reason: "destination must not be a symlink" };
	}
	if (opts.exists) {
		return { ok: false, code: "destination_blocked", reason: "destination already exists; saveTo never overwrites" };
	}
	if (!isInside(absolute, projectRoot)) {
		return { ok: false, code: "destination_blocked", reason: "destination is outside the project" };
	}
	if (isInside(absolute, configDir)) {
		return { ok: false, code: "destination_blocked", reason: "destination is inside the protected configuration directory" };
	}
	if (!boundary.available) {
		return {
			ok: false,
			code: "destination_blocked",
			reason: `datastore boundary unavailable: ${boundary.reason}`,
		};
	}
	for (const root of boundary.roots) {
		if (isInside(absolute, root) || absolute === root) {
			return { ok: false, code: "destination_blocked", reason: "destination is inside a datastore root" };
		}
	}
	return { ok: true };
}

function isInside(candidate: string, parent: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
