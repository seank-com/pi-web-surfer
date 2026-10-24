import { constants as fsConstants } from "node:fs";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Project configuration (D2). Lives at `<project>/<CONFIG_DIR_NAME>/web-surfer/
 * config.json`. Missing config uses defaults; invalid config disables network
 * operations and reports `config_invalid` until corrected — it never silently
 * enables permissive defaults. The document loads completely or not at all.
 */

export interface SearchConfig {
	backend: "auto" | "gemini" | "duckduckgo";
	maxResults: number;
}

export interface FetchConfig {
	maxBodyBytes: number;
	chunkBytes: number;
	maxRedirects: number;
	privateNetworks: "allow" | "deny";
}

export interface WebSurferConfig {
	search: SearchConfig;
	fetch: FetchConfig;
}

export const CONFIG_SCHEMA_VERSION = 1;

export const BODY_BYTES_CEILING = 64 * 1024 * 1024; // 64 MiB (D9)
export const CHUNK_BYTES_CEILING = 256_000; // D9
export const MAX_RESULTS_MIN = 1;
export const MAX_RESULTS_MAX = 10;

export const DEFAULT_CONFIG: WebSurferConfig = {
	search: { backend: "auto", maxResults: 10 },
	fetch: {
		maxBodyBytes: 1_048_576,
		chunkBytes: 51_200,
		maxRedirects: 5,
		privateNetworks: "allow",
	},
};

export interface ConfigLoadResult {
	config?: WebSurferConfig;
	/** Set when the config file exists but is invalid; network ops disabled. */
	invalid?: string;
}

export function configDirectory(cwd: string, configDirName = ".pi"): string {
	return path.join(cwd, configDirName, "web-surfer");
}

export function configPath(cwd: string, configDirName = ".pi"): string {
	return path.join(configDirectory(cwd, configDirName), "config.json");
}

function assertOwnedAndMode(lstat: ReturnType<typeof lstatSync> | null, target: string, mode: number): string | undefined {
	if (!lstat) return `${target}: missing`;
	if (lstat.isSymbolicLink()) return `${target}: must not be a symlink`;
	if (process.getuid && lstat.uid !== process.getuid()) return `${target}: not owned by current user`;
	if ((Number(lstat.mode) & (fsConstants.S_IRWXU | fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== mode) return `${target}: expected mode ${mode.toString(8)}`;
	return undefined;
}

/**
 * Loads and strictly validates the complete configuration document.
 * Unknown or duplicate keys, unsafe file types, wrong ownership/modes, and
 * out-of-range values all invalidate the whole document.
 */
export function loadConfig(cwd: string, configDirName = ".pi"): ConfigLoadResult {
	const file = configPath(cwd, configDirName);
	const dir = configDirectory(cwd, configDirName);

	let dirStat: ReturnType<typeof lstatSync> | null = null;
	try {
		dirStat = lstatSync(dir);
	} catch {
		// No config directory: defaults.
		return { config: structuredClone(DEFAULT_CONFIG) };
	}
	const dirProblem = assertOwnedAndMode(dirStat, "config directory", fsConstants.S_IRWXU);
	if (dirProblem) return { invalid: dirProblem };
	if (!dirStat!.isDirectory()) return { invalid: `config path is not a directory: ${dir}` };

	let fileStat: ReturnType<typeof lstatSync> | null = null;
	try {
		fileStat = lstatSync(file);
	} catch {
		// Directory exists but no config file: defaults.
		return { config: structuredClone(DEFAULT_CONFIG) };
	}
	const fileProblem = assertOwnedAndMode(fileStat, "config file", fsConstants.S_IRUSR | fsConstants.S_IWUSR);
	if (fileProblem) return { invalid: fileProblem };
	if (!fileStat!.isFile()) return { invalid: `config path is not a regular file: ${file}` };

	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (err) {
		return { invalid: `config unreadable: ${errMessage(err)}` };
	}

	// Reject duplicate keys by scanning the raw document (post-parse objects
	// cannot reveal a key that appeared twice).
	let doc: unknown;
	try {
		const duplicate = findDuplicateKeys(raw);
		if (duplicate !== null) return { invalid: `duplicate key: ${duplicate}` };
		doc = JSON.parse(raw);
	} catch (err) {
		return { invalid: `config is not valid JSON: ${errMessage(err)}` };
	}

	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return { invalid: "config root must be a JSON object" };
	}
	const root = doc as Record<string, unknown>;
	const unknownRoot = Object.keys(root).filter((k) => k !== "schemaVersion" && k !== "search" && k !== "fetch");
	if (unknownRoot.length > 0) return { invalid: `unknown config keys: ${unknownRoot.join(", ")}` };
	if (root.schemaVersion !== undefined && root.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		return { invalid: `unsupported schemaVersion: ${String(root.schemaVersion)}` };
	}

	const result: ConfigLoadResult = { config: structuredClone(DEFAULT_CONFIG) };

	if (root.search !== undefined) {
		const problem = validateSearch(root.search, result.config!.search);
		if (problem) return { invalid: problem };
	}
	if (root.fetch !== undefined) {
		const problem = validateFetch(root.fetch, result.config!.fetch);
		if (problem) return { invalid: problem };
	}
	return result;
}

function validateSearch(input: unknown, out: SearchConfig): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return "search: must be an object";
	const rec = input as Record<string, unknown>;
	const unknown = Object.keys(rec).filter((k) => !["backend", "maxResults"].includes(k));
	if (unknown.length > 0) return `search: unknown keys: ${unknown.join(", ")}`;
	if (rec.backend !== undefined) {
		if (rec.backend !== "auto" && rec.backend !== "gemini" && rec.backend !== "duckduckgo") {
			return `search.backend: must be auto, gemini, or duckduckgo`;
		}
		out.backend = rec.backend;
	}
	if (rec.maxResults !== undefined) {
		if (!isPositiveSafeInteger(rec.maxResults) || rec.maxResults < MAX_RESULTS_MIN || rec.maxResults > MAX_RESULTS_MAX) {
			return `search.maxResults: must be an integer between ${MAX_RESULTS_MIN} and ${MAX_RESULTS_MAX}`;
		}
		out.maxResults = rec.maxResults;
	}
	return undefined;
}

function validateFetch(input: unknown, out: FetchConfig): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return "fetch: must be an object";
	const rec = input as Record<string, unknown>;
	const known = ["maxBodyBytes", "chunkBytes", "maxRedirects", "privateNetworks"];
	const unknown = Object.keys(rec).filter((k) => !known.includes(k));
	if (unknown.length > 0) return `fetch: unknown keys: ${unknown.join(", ")}`;
	if (rec.maxBodyBytes !== undefined) {
		if (!isPositiveSafeInteger(rec.maxBodyBytes) || rec.maxBodyBytes > BODY_BYTES_CEILING) {
			return `fetch.maxBodyBytes: must be a positive integer at most ${BODY_BYTES_CEILING}`;
		}
		out.maxBodyBytes = rec.maxBodyBytes;
	}
	if (rec.chunkBytes !== undefined) {
		if (!isPositiveSafeInteger(rec.chunkBytes) || rec.chunkBytes > CHUNK_BYTES_CEILING) {
			return `fetch.chunkBytes: must be a positive integer at most ${CHUNK_BYTES_CEILING}`;
		}
		out.chunkBytes = rec.chunkBytes;
	}
	if (rec.maxRedirects !== undefined) {
		if (typeof rec.maxRedirects !== "number" || !Number.isSafeInteger(rec.maxRedirects) || rec.maxRedirects < 0) {
			return "fetch.maxRedirects: must be a nonnegative integer";
		}
		out.maxRedirects = rec.maxRedirects;
	}
	if (rec.privateNetworks !== undefined) {
		if (rec.privateNetworks !== "allow" && rec.privateNetworks !== "deny") {
			return "fetch.privateNetworks: must be allow or deny";
		}
		out.privateNetworks = rec.privateNetworks;
	}
	return undefined;
}

/**
 * Scans raw JSON text for a key that appears twice within the same object.
 * Returns the first such key, or null. String-aware (quotes and escapes).
 */
export function findDuplicateKeys(raw: string): string | null {
	type Frame = { kind: "obj"; keys: Set<string> } | { kind: "arr" };
	const stack: Frame[] = [];
	let i = 0;
	const n = raw.length;

	while (i < n) {
		const ch = raw[i]!;
		if (ch === '"') {
			// Consume the string; report it if it is an object key.
			let j = i + 1;
			while (j < n) {
				if (raw[j] === "\\") j += 2;
				else if (raw[j] === '"') break;
				else j++;
			}
			if (j >= n) return null; // unterminated: JSON.parse will report
			const top = stack[stack.length - 1];
			if (top && top.kind === "obj") {
				let k = j + 1;
				while (k < n && /\s/.test(raw[k]!)) k++;
				if (raw[k] === ":") {
					const key = JSON.parse(raw.slice(i, j + 1)) as string;
					if (top.keys.has(key)) return key;
					top.keys.add(key);
				}
			}
			i = j + 1;
			continue;
		}
		if (ch === "{") {
			stack.push({ kind: "obj", keys: new Set() });
			i++;
			continue;
		}
		if (ch === "}") {
			stack.pop();
			i++;
			continue;
		}
		if (ch === "[") {
			stack.push({ kind: "arr" });
			i++;
			continue;
		}
		if (ch === "]") {
			stack.pop();
			i++;
			continue;
		}
		i++;
	}
	return null;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Writes a config document with the protected file discipline (0700
 * directory, 0600 file). Used by tests and by operators; never by the
 * extension at runtime against a live project.
 */
export function writeConfigFixture(cwd: string, doc: unknown, configDirName = ".pi"): string {
	const dir = configDirectory(cwd, configDirName);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, "config.json");
	writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
	return file;
}

export function tmpProject(prefix = "websurfer-"): string {
	return path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
}
