import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Top-level template resolution for injected request bodies and header
 * values (D14). Three placeholder kinds:
 *
 *   {{env:NAME}}        process environment, resolved at call time. Only
 *                       top-level templates resolve {{env:}}; spliced file
 *                       or template content never does, so untrusted text
 *                       cannot reference credentials.
 *   {{file:path}}       reads a file (OS-bound) and splices its text in,
 *                       as-is: no placeholder resolution of the spliced
 *                       content, no escaping or encoding transformation.
 *   {{template:path,{vars}}}
 *                       reads a template file, resolves {{name}} against
 *                       the JSON variable map, then continues placeholder
 *                       resolution in the result ({{file:}}/{{template:}}
 *                       only, never {{env:}}), depth-capped with cycle
 *                       detection.
 *
 * Recursion depth cap is 3. Cycle detection uses canonical paths. A JSON
 * map parse failure falls back to naive key:value parsing with a warning.
 */

export const TEMPLATE_DEPTH_CAP = 3;

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}

export function isTemplateError(err: unknown): err is TemplateError {
	return err instanceof TemplateError;
}

export interface TemplateWarning {
	message: string;
}

export interface ResolveResult {
	value: string;
	warnings: TemplateWarning[];
	/** Set when an env variable was referenced but unset or empty-invalid. */
	missingEnv?: string;
}


export function resolveTopLevelTemplate(template: string, env: NodeJS.ProcessEnv = process.env,options:{maxBytes?:number;cwd?:string}={}): ResolveResult {
	return resolve(template, env, new Set(), 0, true,options.maxBytes??1048576,options.cwd??process.cwd());
}

function resolve(
	text: string,
	env: NodeJS.ProcessEnv,
	visited: Set<string>,
	depth: number,
	topLevel: boolean,
	maxBytes:number,
	cwd:string,
): ResolveResult {
	if(Buffer.byteLength(text)>maxBytes)throw new TemplateError('Template payload exceeds body cap');
	const warnings: TemplateWarning[] = [];
	let missingEnv: string | undefined;
	let out = "";
	let i = 0;

	while (i < text.length) {
		const open = text.indexOf("{{", i);
		if (open === -1) break;
		out += text.slice(i, open);
		const close = findPlaceholderEnd(text, open + 2);
		if (close === -1) {
			// Unterminated placeholder: keep the rest verbatim and stop.
			out += text.slice(i);
			return { value: out, warnings, missingEnv };
		}
		const spec = text.slice(open + 2, close).trim();
		i = close + 2;

		if (spec.startsWith("env:")) {
			const name = spec.slice(4).trim();
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				throw new TemplateError(`invalid env variable name: ${name}`);
			}
			if (!topLevel) {
				// {{env:}} never resolves inside spliced content.
				warnings.push({ message: `{{env:${name}}} ignored: env resolution is top-level only` });
				continue;
			}
			const value = env[name];
			if (value === undefined) {
				missingEnv = name;
				continue;
			}
			out += value;
			continue;
		}

		if (spec.startsWith("file:")) {
			const filePath = spec.slice(5).trim();
			const fileContent = readFileForSplice(filePath,maxBytes,cwd);
			if (fileContent.error) {
				throw new TemplateError(fileContent.error);
			}
			// As-is splice: no further resolution of file content.
			out += fileContent.text ?? "";
			continue;
		}

		if (spec.startsWith("template:")) {
			const templateSpec = spec.slice(9).trim();
			if (depth + 1 > TEMPLATE_DEPTH_CAP) {
				throw new TemplateError(`template recursion exceeds depth cap of ${TEMPLATE_DEPTH_CAP}`);
			}
			const { templatePath, vars } = parseTemplateSpec(templateSpec, warnings);
			const canonical = canonicalPath(templatePath,cwd);
			if (visited.has(canonical)) {
				throw new TemplateError(`template cycle detected: ${templatePath}`);
			}
			const content = readFileForSplice(templatePath,maxBytes,cwd);
			if (content.error) {
				throw new TemplateError(content.error);
			}
			const nextVisited = new Set(visited);
			nextVisited.add(canonical);
			const substituted = substituteVars(content.text ?? "", vars, warnings);
			// Continue resolution in the result (depth incremented).
			const nested = resolve(substituted, env, nextVisited, depth + 1, false,maxBytes,cwd);
			warnings.push(...nested.warnings);
			if (nested.missingEnv) missingEnv = missingEnv ?? nested.missingEnv;
			out += nested.value;
			continue;
		}

		// A plain {{name}} variable, not a recognized placeholder: leave as-is.
		out += text.slice(open, close + 2);
	}
	out += text.slice(i);
	if(Buffer.byteLength(out)>maxBytes)throw new TemplateError('Expanded payload exceeds body cap');
	return { value: out, warnings, missingEnv };
}

/**
 * Finds the closing `}}` of a placeholder opening at `{{` (start is the
 * index after the opening braces). Returns the index of the first `}` of
 * the closing pair, or -1. For template specs the scan is brace-depth aware
 * so a vars object's own braces cannot terminate the placeholder early.
 */
function findPlaceholderEnd(text: string, start: number): number {
	let kind = "";
	for (const prefix of ["env:", "file:", "template:"]) {
		if (text.startsWith(prefix, start)) {
			kind = prefix;
			break;
		}
	}
	if (kind === "template:") {
		// The spec may contain a brace-balanced vars object, so the
		// placeholder closes at the first `}}` pair whose preceding content
		// is brace-balanced (string-aware prefix depth).
		let depth=0,inString=false;
		for(let i=start;i<text.length;i++){
			const ch=text[i];
			if(inString){if(ch==='\\')i++;else if(ch==='"')inString=false;continue;}
			if(ch==='}'&&text[i+1]==='}'&&depth===0)return i;
			if(ch==='"')inString=true;else if(ch==='{')depth++;else if(ch==='}')depth--;
		}
		return -1;
	}
	// env/file and plain variables: the first `}}` closes the placeholder.
	const idx = text.indexOf("}}", start);
	return idx === -1 ? -1 : idx;
}

function substituteVars(text: string, vars: Record<string, string>, warnings: TemplateWarning[]): string {
	return text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (whole, name: string) => {
		if (name in vars) return vars[name]!;
		warnings.push({ message: `unresolved template variable: {{${name}}}` });
		return whole;
	});
}

/** Reads a file for splicing. Returns either its text or an error message. */
function readFileForSplice(filePath: string,maxBytes:number,cwd:string): { text?: string; error?: string } {
	filePath=path.resolve(cwd,filePath);
	let st: import("node:fs").Stats;
	try {
		st = lstatSync(filePath);
	} catch {
		return { error: `cannot read file: ${filePath}` };
	}
	if (!st.isFile()) return { error: `not a regular file: ${filePath}` };
	if(st.size>maxBytes)return {error:'Spliced file exceeds body cap'};
	try {
		return { text: readFileSync(filePath, "utf8") };
	} catch (err) {
		return { error: `cannot read file: ${filePath} (${err instanceof Error ? err.message : String(err)})` };
	}
}

/** Canonical form of a path for cycle detection: realpath when it exists. */
function canonicalPath(p: string,cwd:string): string {
	const resolved = path.resolve(cwd,p);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Splits `path,{vars}` from a template spec. The vars part is the trailing
 * brace-balanced object (string-aware); no vars means an empty map. A JSON
 * parse failure falls back to naive key:value parsing with a warning.
 */
function parseTemplateSpec(
	spec: string,
	warnings: TemplateWarning[],
): { templatePath: string; vars: Record<string, string> } {
	let split = -1;
	let depth = 0;
	let inStr = false;
	for (let i = 0; i < spec.length; i++) {
		const ch = spec[i]!;
		if (inStr) {
			if (ch === "\\") i++;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') { inStr = true; continue; }
		if (ch === "{") {
			if (depth === 0) split = i;
			depth++;
		} else if (ch === "}") depth--;
	}
	if (split === -1) {
		return { templatePath: spec.trim(), vars: {} };
	}
	const templatePath = spec.slice(0, split).replace(/,\s*$/, "").trim();
	const raw = spec.slice(split);
	let vars: Record<string, string> = {};
	try {
		const obj = JSON.parse(raw);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
			throw new Error("not an object");
		}
		for (const [k, v] of Object.entries(obj)) vars[k] = String(v);
	} catch {
		warnings.push({
			message: `variable map is not valid JSON; falling back to naive key:value parsing`,
		});
		for (const pair of splitTopLevel(raw.slice(1,-1))) {
			if (!pair.trim()) continue;
			const idx = pair.indexOf(":");
			if (idx === -1) {
				vars[stripQuotes(pair.trim())] = "";
				continue;
			}
			const key = stripQuotes(pair.slice(0, idx).trim());
			const value = stripQuotes(pair.slice(idx + 1).trim());
			vars[key] = value;
		}
	}
	return { templatePath, vars };
}

/** Splits on top-level commas, ignoring commas inside single or double quotes. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote) {
			current += ch;
			if (ch === "\\" && i + 1 < text.length) {
				current += text[i + 1]!;
				i++;
			} else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
		if (ch === ",") { parts.push(current); current = ""; continue; }
		current += ch;
	}
	parts.push(current);
	return parts;
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0]!;
		const last = s[s.length - 1]!;
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}
