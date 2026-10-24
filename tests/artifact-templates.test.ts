import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTopLevelTemplateAsync,resolveTopLevelTemplate} from '../src/templates.ts';

test('artifact template splices are complete literal text or JSON strings, never recursively interpreted',async()=>{
 const source='quoted "text"\\path\n{{env:SECRET}} {{file:never-read}}';
 const options={cwd:process.cwd(),artifact:async(id:string)=>{assert.equal(id,'fixture-id');return source;}};
 const literal=await resolveTopLevelTemplateAsync('before {{artifact:fixture-id}} after',{SECRET:'must-not-expand'},options);
 assert.equal(literal.value,'before '+source+' after');
 const json=await resolveTopLevelTemplateAsync('{"prompt":{{artifact:fixture-id,json}}}',{SECRET:'must-not-expand'},options);
 assert.equal(JSON.parse(json.value).prompt,source);
 assert.throws(()=>resolveTopLevelTemplate('{{artifact:fixture-id}}'),/asynchronous resolver/);
 await assert.rejects(resolveTopLevelTemplateAsync('{{artifact:fixture-id,unknown}}',{},options),/Use/);
 await assert.rejects(resolveTopLevelTemplateAsync('{{artifact:fixture-id}}',{}, {...options,artifact:async()=>{throw new Error('unavailable');}}),/unavailable/);
});
