import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;

/**
 * Content representation for stored source bytes (D8).
 *
 * UTF-8 text is served as text. HTML in readable mode is converted to
 * Markdown with parse5 (declared dependency, fixture-verified). XML, JSON,
 * and ordinary text retain their text representation. Invalid/unsupported
 * encodings and binary content use the artifact-summary path instead of
 * lossy replacement characters. `raw` means no HTML extraction, not
 * arbitrary binary bytes forced into a text block.
 */

export interface TextRepresentation {
	kind: "text";
	text: Buffer; // UTF-8 bytes of the served representation
}

export interface BinaryRepresentation {
	kind: "binary";
	contentType?: string;
	sizeBytes: number;
}

export type Representation = TextRepresentation | BinaryRepresentation;

const BINARY_CONTENT_TYPES = new Set([
	"image/",
	"audio/",
	"video/",
	"application/zip",
	"application/gzip",
	"application/x-gzip",
	"application/x-bzip2",
	"application/x-7z-compressed",
	"application/octet-stream",
	"application/pdf",
	"application/wasm",
]);

export function isBinaryContent(contentType: string | undefined, bytes: Buffer): boolean {
	if (contentType) {
		const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
		if (BINARY_CONTENT_TYPES.has(ct)) return true;
		for (const prefix of ["image/", "audio/", "video/"]) {
			if (ct.startsWith(prefix)) return true;
		}
	}
	// NUL byte in the leading window is a strong binary signal.
	const window = bytes.subarray(0, 8192);
	return window.includes(0);
}

export function isHtmlContent(contentType: string | undefined, sourcePath: string | undefined): boolean {
	if (contentType) {
		const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
		if (ct === "text/html" || ct === "application/xhtml+xml") return true;
	}
	if (sourcePath) {
		const ext = sourcePath.toLowerCase().split(".").pop();
		if (ext === "html" || ext === "htm") return true;
	}
	return false;
}

function tryUtf8(bytes: Buffer): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

export interface RepresentInput {
	bytes: Buffer;
	contentType?: string;
	sourcePath?: string;
}

/**
 * Prepares the served representation for a mode. `readable` runs HTML
 * extraction; `raw` serves the decoded text with no extraction. Binary or
 * undecodable content always yields a binary representation (the artifact
 * keeps the original bytes either way).
 */
export function represent(input: RepresentInput, mode: "readable" | "raw"): Representation {
	const { bytes, contentType, sourcePath } = input;
	if (isBinaryContent(contentType, bytes)) {
		return { kind: "binary", contentType, sizeBytes: bytes.length };
	}
	const text = tryUtf8(bytes);
	if (text === undefined) {
		return { kind: "binary", contentType, sizeBytes: bytes.length };
	}
	if (mode === "raw") {
		return { kind: "text", text: Buffer.from(text, "utf8") };
	}
	// readable mode
	if (isHtmlContent(contentType, sourcePath)) {
		const markdown = htmlToMarkdown(text);
		return { kind: "text", text: Buffer.from(markdown, "utf8") };
	}
	return { kind: "text", text: Buffer.from(text, "utf8") };
}

// ---------------------------------------------------------------------------
// HTML to Markdown (parse5 tree walk)
// ---------------------------------------------------------------------------

type AnyNode = Element | TextNode | DocumentFragment;
function getAttribute(el: Element, name: string): string | null {
	for (const attr of el.attrs) {
		if (attr.name === name) return attr.value;
	}
	return null;
}

function textContentOf(node: AnyNode): string {
	if (node.nodeName === "#text") return (node as TextNode).value;
	if (!("childNodes" in node)) return "";
	return (node as Element).childNodes.map((c) => textContentOf(c as AnyNode)).join("");
}


export function htmlToMarkdown(html: string): string {
	const fragment = parseFragment(html);
	const lines: string[] = [];
	walkNode(fragment as AnyNode, lines, { listDepth: 0, inPre: false });
	// Collapse 3+ blank lines and trim trailing whitespace per line.
	const out = lines
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return out + "\n";
}

interface WalkState {
	listDepth: number;
	inPre: boolean;
}

function walkNode(node: AnyNode, out: string[], state: WalkState): void {
	if (node.nodeName === "#document-fragment" || node.nodeName === "#document") {
		for (const child of (node as DocumentFragment).childNodes) {
			walkNode(child as unknown as AnyNode, out, state);
		}
		return;
	}
	if ("nodeName" in node && node.nodeName === "#text") {
		if (state.inPre) {
			out.push((node as TextNode).value);
		} else {
			const value = (node as TextNode).value
				.replace(/\s+/g, " ")
				.trim();
			if (value) out.push(value);
		}
		return;
	}
	if (!("childNodes" in node)) return;
	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	if (["script", "style", "noscript", "template", "svg", "math", "head", "title"].includes(tag)) {
		return;
	}
	if (["nav", "footer", "header"].includes(tag)) {
		// Kept: structural landmarks may carry real content on article pages.
	}

	const block = isBlockTag(tag);
	if (block) pushBlank(out);

	switch (tag) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = Number(tag[1]);
			const text = inlineContent(el);
			if (text.trim()) out.push(`${"#".repeat(level)} ${text.trim()}`);
			break;
		}
		case "pre": {
			const code = textContentOf(el).replace(/\n+$/, "");
			out.push("```\n" + code + "\n```");
			break;
		}
		case "blockquote": {
			const nested: string[] = [];
			for (const child of el.childNodes) walkNode(child as AnyNode, nested, { ...state, inPre: false });
			const quoted = nested
				.map((l) => (l.trim() ? `> ${l}` : ">"))
				.join("\n")
				.replace(/\n(>)*\s*$/, "");
			if (quoted.trim()) out.push(quoted);
			break;
		}
		case "ul":
		case "ol": {
			const ordered = tag === "ol";
			let index = 0;
			const itemText: string[] = [];
			for (const child of el.childNodes) {
				if (child.nodeName !== "li") continue;
				index++;
				const itemState: WalkState = { listDepth: state.listDepth + 1, inPre: false };
				walkLi(child as AnyNode, itemText, itemState, ordered ? `${index}. ` : "- ");
			}
			out.push(...itemText.filter((l) => l !== ""));
			break;
		}
		case "p": {
			const text = inlineContent(el);
			if (text.trim()) out.push(text.trim());
			break;
		}
		case "br": {
			out.push("\n");
			break;
		}
		case "hr": {
			out.push("---");
			break;
		}
		case "table": {
			const text = textContentOf(el).trim();
			if (text) out.push(text.slice(0, 2000));
			break;
		}
		default: {
			for (const child of el.childNodes) walkNode(child as AnyNode, out, state);
		}
	}

	if (block) pushBlank(out);
}

function walkLi(node: AnyNode, out: string[], state: WalkState, bullet: string): void {
	const lines: string[] = [];
	if (node && "childNodes" in node) {
		for (const child of (node as Element).childNodes) {
			walkNode(child as unknown as AnyNode, lines, state);
		}
	}
	const flat = lines.map((l) => l.trim()).filter((l) => l !== "");
	const first = flat[0] ?? "";
	out.push(`${bullet}${first}`);
	for (const rest of flat.slice(1)) {
		out.push(`  ${rest}`);
	}
}

function pushBlank(out: string[]): void {
	if (out.length > 0 && out[out.length - 1] !== "") out.push("");
}

function isBlockTag(tag: string): boolean {
	return [
		"p", "div", "section", "article", "main", "aside", "header", "footer", "nav",
		"h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "blockquote", "table",
		"figure", "figcaption", "hr", "form", "fieldset", "details", "summary", "dl",
	].includes(tag);
}

function inlineContent(el: Element): string {
	const parts: string[] = [];
	for (const child of el.childNodes) {
		collectInline(child as AnyNode, parts, false);
	}
	return parts
		.map((p) => p.replace(/\s+/g, " "))
		.join("")
		.trim();
}

function collectInline(node: AnyNode, out: string[], code: boolean): void {
	if (!node || !("nodeName" in node)) return;
	if (node.nodeName === "#text") {
		out.push((node as TextNode).value);
		return;
	}
	const el = node as Element;
	const tag = el.tagName.toLowerCase();
	if (["script", "style", "noscript"].includes(tag)) return;
	if (tag === "code" && !code) {
		out.push("`" + textContentOf(el).trim() + "`");
		return;
	}
	if (tag === "a") {
		const text = textContentOf(el).trim();
		const href = getAttribute(el, "href");
		if (href && text) {
			out.push(`[${text}](${href})`);
			return;
		}
		if (text) {
			out.push(text);
			return;
		}
	}
	if (["strong", "b"].includes(tag)) {
		const text = textContentOf(el).trim();
		if (text) {
			out.push(`**${text}**`);
			return;
		}
	}
	if (["em", "i"].includes(tag)) {
		const text = textContentOf(el).trim();
		if (text) {
			out.push(`*${text}*`);
			return;
		}
	}
	if (tag === "img") {
		const alt = getAttribute(el, "alt");
		const src = getAttribute(el, "src");
		if (alt && src) {
			out.push(`[image: ${alt}](${src})`);
			return;
		}
		if (alt) {
			out.push(`[image: ${alt}]`);
			return;
		}
	}
	if (tag === "br") {
		out.push("\n");
		return;
	}
	for (const child of el.childNodes) collectInline(child as AnyNode, out, code);
}
