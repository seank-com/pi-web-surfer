import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, isBinaryContent, isHtmlContent, represent } from '../src/extract.ts';

test('official engine: headings, paragraphs, and emphasis', async () => {
 const md=await htmlToMarkdown('<h1>Title</h1><h2>Sub</h2><p>Hello <strong>bold</strong> and <em>italic</em>.</p>');
 for(const text of ['# Title','## Sub','**bold**','*italic*'])assert.ok(md.includes(text));
});
test('official engine: links, scripts and styles',async()=>{
 const md=await htmlToMarkdown('<script>var x = 1;</script><style>.a{}</style><p>See <a href="https://example.com/x">the docs</a>.</p>');
 assert.ok(md.includes('[the docs](https://example.com/x)'));assert.ok(!md.includes('var x'));assert.ok(!md.includes('.a{}'));
});
test('official engine: code blocks and inline code',async()=>{
 const md=await htmlToMarkdown('<p>Inline <code>const a = 1;</code></p><pre>function f() {\n return 2;\n}</pre>');
 for(const text of ['`const a = 1;`','```','function f() {'])assert.ok(md.includes(text));
});
test('official engine: unordered and ordered lists',async()=>{
 const md=await htmlToMarkdown('<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
 assert.match(md,/[-*] one/);assert.match(md,/[-*] two/);assert.ok(md.includes('1. first'));assert.ok(md.includes('2. second'));
});
test('official engine: CJK content is retained',async()=>{
 const md=await htmlToMarkdown('<p>日本語のテキスト。中文内容。</p>');
 assert.ok(md.includes('日本語のテキスト'));assert.ok(md.includes('中文内容'));assert.ok(!md.includes('\uFFFD'));
});
test('binary content is detected by content type and NUL bytes',()=>{
 assert.equal(isBinaryContent('image/png',Buffer.from('x')),true);assert.equal(isBinaryContent('application/zip',Buffer.from('x')),true);assert.equal(isBinaryContent('text/html',Buffer.from('hello')),false);assert.equal(isBinaryContent(undefined,Buffer.from([0,1,2])),true);assert.equal(isBinaryContent(undefined,Buffer.from('plain text')),false);
});
test('HTML detection uses media type or extension',()=>{
 assert.equal(isHtmlContent('text/html; charset=utf-8',undefined),true);assert.equal(isHtmlContent('application/json',undefined),false);assert.equal(isHtmlContent(undefined,'page.html'),true);assert.equal(isHtmlContent(undefined,'page.htm'),true);assert.equal(isHtmlContent(undefined,'page.txt'),false);
});
test('represent: official readable conversion and unchanged raw HTML',async()=>{
 const html='<h1>Head</h1><p>Body</p>';
 const readable=await represent({bytes:Buffer.from(html),contentType:'text/html'},'readable');assert.ok(readable.kind==='text'&&readable.text.toString().includes('# Head'));
 const raw=await represent({bytes:Buffer.from(html),contentType:'text/html'},'raw');assert.ok(raw.kind==='text'&&raw.text.toString().includes('<h1>'));
});
test('invalid UTF-8 remains binary without lossy replacement',async()=>{
 assert.equal((await represent({bytes:Buffer.from([0xff,0xfe,0,1]),contentType:'text/plain'},'readable')).kind,'binary');
});
test('plain text and JSON pass through unchanged',async()=>{
 const json='{"a":1,"b":[2,3]}';for(const mode of ['readable','raw'] as const){const result=await represent({bytes:Buffer.from(json),contentType:'application/json'},mode);assert.ok(result.kind==='text'&&result.text.toString()===json);}
});
