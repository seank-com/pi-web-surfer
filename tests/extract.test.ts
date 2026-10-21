import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, isBinaryContent, isHtmlContent, represent } from "../src/extract.ts";

test("headings, paragraphs, and emphasis convert to Markdown", () => {
	const html = "<h1>Title</h1><h2>Sub</h2><p>Hello <strong>bold</strong> and <em>italic</em>.</p>";
	const md = htmlToMarkdown(html);
	assert.ok(md.includes("# Title"));
	assert.ok(md.includes("## Sub"));
	assert.ok(md.includes("**bold**"));
	assert.ok(md.includes("*italic*"));
});

test("links become Markdown links; scripts and styles are dropped", () => {
	const html =
		"<script>var x = 1;</script><style>.a{}</style><p>See <a href=\"https://example.com/x\">the docs</a>.</p>";
	const md = htmlToMarkdown(html);
	assert.ok(md.includes("[the docs](https://example.com/x)"));
	assert.ok(!md.includes("var x"));
	assert.ok(!md.includes(".a{}"));
});

test("code blocks and inline code are preserved", () => {
	const html = "<p>Inline <code>const a = 1;</code></p><pre>\nfunction f() {\n  return 2;\n}\n</pre>";
	const md = htmlToMarkdown(html);
	assert.ok(md.includes("`const a = 1;`"));
	assert.ok(md.includes("```"));
	assert.ok(md.includes("function f() {"));
});

test("lists convert with bullets and indentation", () => {
	const html = "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>";
	const md = htmlToMarkdown(html);
	assert.ok(md.includes("- one"));
	assert.ok(md.includes("- two"));
	assert.ok(md.includes("1. first"));
	assert.ok(md.includes("2. second"));
});

test("CJK text survives extraction without replacement characters", () => {
	const html = "<p>日本語のテキスト。中文内容。</p>";
	const md = htmlToMarkdown(html);
	assert.ok(md.includes("日本語のテキスト"));
	assert.ok(md.includes("中文内容"));
	assert.ok(!md.includes("\uFFFD"));
});

test("binary content is detected by content type and NUL bytes", () => {
	assert.equal(isBinaryContent("image/png", Buffer.from("x")), true);
	assert.equal(isBinaryContent("application/zip", Buffer.from("x")), true);
	assert.equal(isBinaryContent("text/html", Buffer.from("hello")), false);
	assert.equal(isBinaryContent(undefined, Buffer.from([0x00, 0x01, 0x02])), true);
	assert.equal(isBinaryContent(undefined, Buffer.from("plain text")), false);
});

test("isHtmlContent uses content type then extension", () => {
	assert.equal(isHtmlContent("text/html; charset=utf-8", undefined), true);
	assert.equal(isHtmlContent("application/json", undefined), false);
	assert.equal(isHtmlContent(undefined, "page.html"), true);
	assert.equal(isHtmlContent(undefined, "page.htm"), true);
	assert.equal(isHtmlContent(undefined, "page.txt"), false);
});

test("represent: readable extracts HTML, raw does not", () => {
	const html = "<h1>Head</h1><p>Body</p>";
	const readable = represent({ bytes: Buffer.from(html, "utf8"), contentType: "text/html" }, "readable");
	assert.equal(readable.kind, "text");
	assert.ok(readable.kind === "text" && readable.text.toString("utf8").includes("# Head"));

	const raw = represent({ bytes: Buffer.from(html, "utf8"), contentType: "text/html" }, "raw");
	assert.equal(raw.kind, "text");
	assert.ok(raw.kind === "text" && raw.text.toString("utf8").includes("<h1>"));
});

test("represent: invalid UTF-8 yields a binary representation (no lossy replacement)", () => {
	// 0xFF is not valid UTF-8 leading byte.
	const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
	const rep = represent({ bytes, contentType: "text/plain" }, "readable");
	assert.equal(rep.kind, "binary");
});

test("represent: plain text and JSON pass through unchanged in both modes", () => {
	const json = '{"a":1,"b":[2,3]}';
	for (const mode of ["readable", "raw"] as const) {
		const rep = represent({ bytes: Buffer.from(json, "utf8"), contentType: "application/json" }, mode);
		assert.equal(rep.kind, "text");
		if (rep.kind === "text") assert.equal(rep.text.toString("utf8"), json);
	}
});
