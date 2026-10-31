import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTopLevelTemplateAsync,resolveTopLevelTemplate} from '../src/templates.ts';

test('artifact template splices are complete literal text or JSON strings, never recursively interpreted',async()=>{
 const source='quoted "text"\\path\n\t\f\u0000\u000b\r é ● {{env:SECRET}} {{file:never-read}}';
 const options={cwd:process.cwd(),artifact:async(id:string)=>{assert.equal(id,'fixture-id');return source;}};
 const literal=await resolveTopLevelTemplateAsync('before {{artifact:fixture-id}} after',{SECRET:'must-not-expand'},options);
 assert.equal(literal.value,'before '+source+' after');
 const json=await resolveTopLevelTemplateAsync('{"prompt":{{artifact:fixture-id,json}}}',{SECRET:'must-not-expand'},options);
 assert.equal(JSON.parse(json.value).prompt,source);
 for(const malformed of ['{"content":"{{artifact:fixture-id,json}}"}','{"content":{{artifact:fixture-id,json}}"}']){
  const resolved=await resolveTopLevelTemplateAsync(malformed,{},options);
  assert.throws(()=>JSON.parse(resolved.value),SyntaxError);
 }
 const readme=await (await import('node:fs/promises')).readFile(new URL('../README.md',import.meta.url),'utf8');
 for(const example of ['{"content":{{artifact:ID,json}}}','{"content":"{{artifact:ID,json}}"}','{"content":{{artifact:ID,json}}"}'])assert.ok(readme.includes(example));
 assert.throws(()=>resolveTopLevelTemplate('{{artifact:fixture-id}}'),/asynchronous resolver/);
 await assert.rejects(resolveTopLevelTemplateAsync('{{artifact:fixture-id,unknown}}',{},options),/Use/);
 await assert.rejects(resolveTopLevelTemplateAsync('{{artifact:fixture-id}}',{}, {...options,artifact:async()=>{throw new Error('unavailable');}}),/unavailable/);
});
