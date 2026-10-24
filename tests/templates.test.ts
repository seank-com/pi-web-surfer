import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TEMPLATE_DEPTH_CAP, isTemplateError, resolveTopLevelTemplate } from "../src/templates.ts";

function tmpfile(name: string, content: string): { file: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "ws-tpl-"));
	const file = path.join(dir, name);
	writeFileSync(file, content);
	return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tmpdirProject(prefix = "ws-tpl-"): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("env resolves from the process environment at call time", () => {
	const result = resolveTopLevelTemplate("hello {{env:USER}}", { USER: "roxy" });
	assert.equal(result.value, "hello roxy");
	assert.equal(result.missingEnv, undefined);
});

test("unset env fails via missingEnv and is not echoed", () => {
	const result = resolveTopLevelTemplate("Bearer {{env:DEFINITELY_NOT_SET_VAR_123}}", { USER: "roxy" });
	assert.equal(result.missingEnv, "DEFINITELY_NOT_SET_VAR_123");
	assert.equal(result.value, "Bearer ");
});

test("file splice is as-is text and does not resolve placeholders", () => {
	const { file, cleanup } = tmpfile("doc.txt", "line one\nline two\n{{env:SHOULD_NOT_RESOLVE}}");
	try {
		const result = resolveTopLevelTemplate("before {{file:" + file + "}} after", { USER: "roxy" });
		assert.equal(result.value, "before line one\nline two\n{{env:SHOULD_NOT_RESOLVE}} after");
	} finally {
		cleanup();
	}
});

test("missing file is a template error", () => {
	const missing = path.join(tmpdir(), "does-not-exist-12345.txt");
	assert.throws(
		() => resolveTopLevelTemplate("{{file:" + missing + "}}"),
		(err) => isTemplateError(err),
	);
});

test("template files resolve vars and continue resolution", () => {
	const { dir, cleanup } = tmpdirProject();
	try {
		const target = path.join(dir, "leaf.txt");
		writeFileSync(target, "FINAL: {{name}}");
		const middle = path.join(dir, "middle.txt");
		writeFileSync(middle, "mid: {{template:" + target + ',{"name":"val"}}}');
		const outer = path.join(dir, "outer.txt");
		writeFileSync(outer, "outer: {{template:" + middle + "}}");

		const r = resolveTopLevelTemplate("{{template:" + outer + "}}");
		assert.equal(r.value, "outer: mid: FINAL: val");
	} finally {
		cleanup();
	}
});

test("env is never resolved inside file content (exfiltration guard)", () => {
	const { dir, cleanup } = tmpdirProject();
	try {
		const secret = path.join(dir, "secret.txt");
		writeFileSync(secret, "key={{env:SECRET_KEY}}");
		const r = resolveTopLevelTemplate("{{file:" + secret + "}}", { SECRET_KEY: "hunter2" });
		assert.equal(r.value, "key={{env:SECRET_KEY}}");
		assert.ok(!r.value.includes("hunter2"));
	} finally {
		cleanup();
	}
});

test("cycle detection fails explicitly", () => {
	const { dir, cleanup } = tmpdirProject();
	try {
		const a = path.join(dir, "a.txt");
		const b = path.join(dir, "b.txt");
		writeFileSync(a, "{{template:" + b + "}}");
		writeFileSync(b, "{{template:" + a + "}}");
		assert.throws(
			() => resolveTopLevelTemplate("{{template:" + a + "}}"),
			(err) => isTemplateError(err),
		);
	} finally {
		cleanup();
	}
});

test("JSON var map parse failure falls back to naive key:value with a warning", () => {
	const { dir, cleanup } = tmpdirProject();
	try {
		const t = path.join(dir, "t.txt");
		writeFileSync(t, "val={{word}}");
		// Intentionally invalid JSON (single quotes) triggers the naive fallback.
		const r = resolveTopLevelTemplate("{{template:" + t + ",{word:'hi'}}}");
		assert.equal(r.value, "val=hi");
		assert.ok(r.warnings.some((w) => w.message.includes("naive key:value")));
	} finally {
		cleanup();
	}
});

test("unresolved template variable keeps the placeholder and warns", () => {
	const { dir, cleanup } = tmpdirProject();
	try {
		const t = path.join(dir, "t.txt");
		writeFileSync(t, "hi {{missing}} there");
		const r = resolveTopLevelTemplate("{{template:" + t + "}}");
		assert.equal(r.value, "hi {{missing}} there");
		assert.ok(r.warnings.some((w) => w.message.includes("unresolved template variable")));
	} finally {
		cleanup();
	}
});

test("recursion depth cap is enforced", () => {
	assert.equal(TEMPLATE_DEPTH_CAP, 3);
	const { dir, cleanup } = tmpdirProject();
	try {
		// Build a chain deeper than the cap: each level wraps the next.
		const n = 6;
		const files: string[] = [];
		for (let i = 0; i < n; i++) {
			const f = path.join(dir, `l${i}.txt`);
			const inner = i + 1 < n ? `{{template:${path.join(dir, `l${i + 1}.txt`)}}}` : "leaf";
			writeFileSync(f, inner);
			files.push(f);
		}
		assert.throws(
			() => resolveTopLevelTemplate("{{template:" + files[0]! + "}}"),
			(err) => isTemplateError(err),
		);
	} finally {
		cleanup();
	}
});
