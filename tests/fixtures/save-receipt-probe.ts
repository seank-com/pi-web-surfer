import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Exercise only the exported factory and registered tool contract. The isolated
// public policy-protocol responder is synthetic; real companion orders have
// separate integration coverage.
const root=await realpath(await mkdtemp(join(tmpdir(),'web-save-receipts-')));
const previousTmp=process.env.TMPDIR;
process.env.TMPDIR=join(root,'tmp');await mkdir(process.env.TMPDIR);
const cwd=join(root,'project');await mkdir(cwd);
const handlers=new Map<string,any>(),tools=new Map<string,any>(),listeners=new Map<string,Set<any>>();
const events={
 on(type:string,handler:any){const set=listeners.get(type)??new Set();set.add(handler);listeners.set(type,set);return()=>set.delete(handler);},
 emit(type:string,data:any){for(const handler of listeners.get(type)??[])handler(data);}
};
events.on('pi-markdown-datastore:v1:capability-request',(request:any)=>events.emit('pi-markdown-datastore:v1:capability-reply',{requestId:request.requestId,capability:{version:1,contractVersion:1,ready:true,policyVersion:1,instanceId:'receipt-fixture'}}));
events.on('pi-markdown-datastore:v1:request',(request:any)=>request.resolve({contractVersion:1,operation:request.request.operation,data:request.request.operation==='roots'?{roots:[]}:{path:request.request.input.path,owned:false}}));
try{
 const entry=process.env.WEB_SURFER_ENTRY??new URL('../../src/index.ts',import.meta.url).href;
 if(process.env.TEST_PI_HOST){
  // Installed packages obtain the host-provided typebox peer through Pi's
  // actual extension loader, just like the standalone package-load probe.
  const {loadExtensions}=await import(pathToFileURL(join(process.env.TEST_PI_HOST,'dist/core/extensions/loader.js')).href);
  const loaded=await loadExtensions([fileURLToPath(entry)],cwd,events);
  assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
  for(const [name,registered] of loaded.extensions[0].tools)tools.set(name,registered.definition);
  for(const [name,callbacks] of loaded.extensions[0].handlers)handlers.set(name,async(...args:any[])=>{for(const callback of callbacks)await callback(...args);});
 }else{
  const {createWebSurferExtension}=await import(entry);
  createWebSurferExtension()({events,registerTool:(tool:any)=>tools.set(tool.name,tool),on:(name:string,handler:any)=>handlers.set(name,handler)});
 }
 await handlers.get('session_start')({}, {cwd});
 const tool=tools.get('web_fetch'),fetch=(args:any)=>tool.execute('receipt',args,undefined,undefined,{cwd});
 assert.ok(tool.description.includes('Correct: {"content":{{artifact:ID,json}}}'));
 assert.ok(tool.description.includes('Incorrect: {"content":"{{artifact:ID,json}}"}'));
 assert.ok(tool.description.includes('one hour after creation, without read renewal'));
 assert.ok(tool.description.includes('{"artifactId":"RETURNED_CONVERTED_ID","view":"artifact","saveTo":"sources/report.md"}'));
 execFileSync(process.env.WEB_SURFER_PYTHON??'python3',[fileURLToPath(new URL('./documents.py',import.meta.url)),cwd],{stdio:'pipe'});
 const text=(result:any)=>result.content.map((c:any)=>c.text??'').join('\n');
 for(const name of ['report.pdf','report.docx']){
  const original=await readFile(join(cwd,name));
  const first=await fetch({path:name,view:'artifact',saveTo:'saved/'+name+'.md'});
  assert.equal(first.details.ok,true,JSON.stringify(first));
  assert.ok(text(first).includes(`[saved: saved/${name}.md; original source bytes; ${original.length} bytes]`));
  assert.deepEqual(await readFile(join(cwd,'saved',name+'.md')),original);
  assert.ok(first.details.artifactId&&first.details.sourceArtifactId);
  assert.notEqual(first.details.artifactId,first.details.sourceArtifactId);
  const second=await fetch({artifactId:first.details.artifactId,view:'artifact',saveTo:'text/'+name+'.md'});
  const converted=await readFile(join(cwd,'text',name+'.md'));
  assert.equal(second.details.savedPath,'text/'+name+'.md');
  assert.ok(text(second).includes(`[saved: text/${name}.md; converted artifact bytes; ${converted.length} bytes]`));
  assert.ok(converted.toString().includes(name.endsWith('pdf')?'PDF-END-COMPLETE':'DOCX fixture source complete.'));
  assert.equal(second.details.returnedBytes,0);
  assert.deepEqual(second.details.provenance,first.details.provenance);
  const pinnedOriginal=await fetch({artifactId:first.details.sourceArtifactId,mode:'raw',view:'artifact',saveTo:'raw/'+name});
  assert.ok(text(pinnedOriginal).includes(`[saved: raw/${name}; original source bytes; ${original.length} bytes]`));
  assert.deepEqual(await readFile(join(cwd,'raw',name)),original);
  for(const saveTo of ['text/'+name+'.md',join(cwd,'absolute-'+name)]){
   const failed=await fetch({artifactId:first.details.artifactId,view:'artifact',saveTo});
   assert.equal(failed.details.savedPath,undefined);
   assert.equal(failed.details.warnings[0].code,'destination_blocked');
   assert.ok(!text(failed).includes('[saved:'));
  }
  for(const result of [first,second,pinnedOriginal])assert.ok(!text(result).includes('PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT'));
 }
 console.log('PASS: registered PDF/DOCX metadata-only original/converted save receipts, byte identity, provenance, failures and guidance');
}finally{
 await handlers.get('session_shutdown')?.({}, {cwd});
 if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;
 await rm(root,{recursive:true,force:true});
}
