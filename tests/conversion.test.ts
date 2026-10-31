import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir,stat,realpath,symlink} from 'node:fs/promises';
import {watch,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {DEFAULT_CONFIG} from '../src/config.ts';
import {executeFetch,type FetchEnvironment} from '../src/fetchcore.ts';
import {KeyLock,readArtifactMeta,readSourceBytes,namespaceRoot} from '../src/artifacts.ts';
import {projectHash,sha256Hex} from '../src/identity.ts';
import {artifactText} from '../src/derived.ts';
import {conversionPython,convertLocal} from '../src/conversion.ts';

test('conversion validates the physical scratch path when TMPDIR is a symlink',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'web-conversion-alias-'))),alias=join(root,'tmp-alias'),previous=process.env.TMPDIR;
 await symlink(root,alias,'dir');process.env.TMPDIR=alias;
 t.after(async()=>{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;await rm(root,{recursive:true,force:true});});
 const converted=await convertLocal(Buffer.from('<h1>Alias conversion</h1>'),'convert',{filename:'fixture.html',mimetype:'text/html'},{validate:async directory=>assert.equal(dirname(directory),root)});
 assert.equal(converted.bytes.toString(),'# Alias conversion');
});

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'web-conversion-fixture-')),cwd=join(root,'project');await mkdir(cwd);
 t.after(async()=>{await rm(join(namespaceRoot(),projectHash(cwd)),{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
 execFileSync(conversionPython(),[fileURLToPath(new URL('./fixtures/documents.py',import.meta.url)),cwd],{stdio:'pipe'});
 const env:FetchEnvironment={cwd,config:{config:structuredClone(DEFAULT_CONFIG)},boundary:{available:true,roots:[]},lock:new KeyLock()};
 env.config.config!.fetch.privateNetworks='allow';
 const fetch=(request:any)=>executeFetch(request,env);
 const meta=(id:string)=>readArtifactMeta(projectHash(cwd),id.split('-')[0]!,id);
 const bytes=(id:string)=>readSourceBytes(projectHash(cwd),id.split('-')[0]!,id);
 return{cwd,env,fetch,meta,bytes};
}
test('HTML/PDF/DOCX are distinct official derived artifacts; metadata-only output and paging preserve originals',async t=>{
 const f=await fixture(t);
 const python=conversionPython(),wrapper=join(f.cwd,'offline-python'),old=process.env.WEB_SURFER_PYTHON;
 const guard="import runpy,socket,sys; block=lambda *a,**k: (_ for _ in ()).throw(AssertionError('network attempted by local converter')); socket.socket.connect=block; socket.socket.connect_ex=block; socket.getaddrinfo=block; sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')";
 await writeFile(wrapper,`#!/bin/bash\nexec '${python}' -c ${JSON.stringify(guard)} "$@"\n`,{mode:0o700});
 process.env.WEB_SURFER_PYTHON=wrapper;t.after(()=>{if(old===undefined)delete process.env.WEB_SURFER_PYTHON;else process.env.WEB_SURFER_PYTHON=old;});
 for(const name of ['page.html','report.pdf','report.docx']){
  const original=await readFile(join(f.cwd,name));
  const converted=await f.fetch({filePath:name,view:'artifact'});
  assert.equal(converted.details.ok,true,JSON.stringify(converted));
  assert.equal(converted.details.returnedBytes,0);
  assert.ok(!JSON.stringify(converted).includes('PDFSOURCE-MUST-STAY'));
  const id=converted.details.artifactId!,source=converted.details.sourceArtifactId!;
  assert.notEqual(id,source);assert.deepEqual(await f.bytes(source),original);
  const meta=(await f.meta(id))!;assert.equal(meta.provenance?.engine,'Microsoft MarkItDown');assert.equal(meta.provenance?.engineVersion,'0.1.9');assert.equal(meta.provenance?.sourceSha256,sha256Hex(original));
  const complete=await artifactText(id,f.env);
  assert.ok(complete.includes(name==='page.html'?'# HTML fixture':name==='report.pdf'?'PDF-END-COMPLETE':'DOCX fixture source complete.'));
  let offset=0,collected='';do{const page=await f.fetch({artifactId:id,chunkBytes:113,offset});assert.equal(page.details.ok,true);assert.ok(page.details.returnedBytes!<=113);const raw=await f.bytes(id);collected+=raw!.subarray(offset,offset+page.details.returnedBytes!).toString();offset=page.details.nextOffset??complete.length;if(page.details.endOfFile)break;}while(offset<Buffer.byteLength(complete));
  assert.equal(collected,complete);assert.deepEqual(await f.bytes(source),original);
 }
});
test('ZIP listing never opens members; selection is indexed, uncapped and never uses member names as paths',async t=>{
 const f=await fixture(t);
 // Patch a public stdlib member-opening method in this isolated test only.
 const probe=`import runpy,sys,zipfile,json; ns=runpy.run_path(sys.argv[1]); zipfile.ZipFile.open=lambda *a,**k: (_ for _ in ()).throw(AssertionError('member decompressed during listing')); print(json.dumps(ns['run']('zip-list',sys.argv[2],sys.argv[3],{})))`;
 execFileSync(conversionPython(),['-c',probe,fileURLToPath(new URL('../python/bridge.py',import.meta.url)),join(f.cwd,'bundle.zip'),join(f.cwd,'list.json')]);
 const original=await f.fetch({filePath:'bundle.zip',mode:'raw',view:'artifact'}),zipId=original.details.artifactId!;
 const listing=await f.fetch({artifactId:zipId,operation:'zip-list',view:'artifact'});
 const entries=JSON.parse(await artifactText(listing.details.artifactId!,f.env));assert.equal(entries.length,5);assert.equal(entries[1].name,'../do-not-extract.txt');assert.equal(typeof entries[2].declaredSize,'string');
 const html=await f.fetch({artifactId:zipId,operation:'convert',memberIndex:0,view:'artifact'});assert.equal(html.details.ok,true);assert.match(await artifactText(html.details.artifactId!,f.env),/# HTML fixture/);const member=(await f.meta(html.details.sourceArtifactId!))!;assert.equal(member.provenance?.sourceArtifactId,zipId);assert.equal(member.provenance?.member?.index,0);assert.deepEqual(await f.bytes(member.artifactId),await readFile(join(f.cwd,'page.html')));
 const selected=await f.fetch({artifactId:zipId,operation:'convert',memberIndex:2,view:'artifact'});assert.equal(selected.details.ok,true,JSON.stringify(selected));
 const full=await artifactText(selected.details.artifactId!,f.env);assert.ok(Buffer.byteLength(full)>2*1024*1024);assert.ok(full.endsWith('LARGE-END-COMPLETE'));assert.equal(selected.details.provenance?.member?.name,'large.txt');
 const a=await f.fetch({artifactId:zipId,operation:'convert',memberIndex:3,view:'artifact'}),b=await f.fetch({artifactId:zipId,operation:'convert',memberIndex:4,view:'artifact'});
 assert.match(await artifactText(a.details.artifactId!,f.env),/FIRST DUPLICATE/);assert.match(await artifactText(b.details.artifactId!,f.env),/SECOND DUPLICATE/);
 const pathMember=await f.fetch({artifactId:zipId,operation:'convert',memberIndex:1,view:'artifact'});assert.equal(await artifactText(pathMember.details.artifactId!,f.env),'NO-FILESYSTEM-EXTRACTION');
 assert.equal(existsSync(join(f.cwd,'../do-not-extract.txt')),false);
 await writeFile(join(f.cwd,'misleading.docx'),await readFile(join(f.cwd,'bundle.zip')));
 const misleading=await f.fetch({filePath:'misleading.docx',operation:'convert',view:'artifact'});assert.equal(misleading.details.code,'conversion_failed');
 assert.deepEqual(await f.bytes(zipId),await readFile(join(f.cwd,'bundle.zip')));
 const implicit=await f.fetch({artifactId:zipId,operation:'convert'});assert.equal(implicit.details.code,'conversion_failed');
});
test('actual web_fetch template posts full converted PDF directly to synthetic Ollama with no source text in tool arguments/results',async t=>{
 const f=await fixture(t);let posted:any;
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);posted=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');res.end(JSON.stringify({response:'Synthetic 300-word summary only.'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const source=await f.fetch({filePath:'report.pdf',view:'artifact'}),id=source.details.artifactId!;
 await writeFile(join(f.cwd,'summarize.json'),' {"model":"fixture","prompt":{{artifact:{{source}},json}},"stream":false}');
 const args={url:`http://127.0.0.1:${(server.address() as any).port}/api/generate`,method:'POST',headers:{'content-type':'application/json'},body:`{{template:summarize.json,{"source":"${id}"}}}`};
 const result=await f.fetch(args);assert.equal(result.details.ok,true,JSON.stringify(result));
 assert.equal(posted.prompt,await artifactText(id,f.env));assert.ok(posted.prompt.includes('PDF-END-COMPLETE'));assert.ok(posted.prompt.length>DEFAULT_CONFIG.fetch.chunkBytes);
 for(const modelVisible of [args,source,result])assert.ok(!JSON.stringify(modelVisible).includes('PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT'));
 assert.match(JSON.stringify(result.content),/Synthetic 300-word summary only/);
 assert.equal(existsSync(join(f.cwd,'saved.pdf')),false);
});
test('artifact splices are literal, project scoped, and recheck current ownership',async t=>{
 const f=await fixture(t);await writeFile(join(f.cwd,'in.txt'),'\uFEFF{{env:NOT_A_REAL_SECRET}} literal');
 const source=await f.fetch({filePath:'in.txt',view:'artifact'}),id=source.details.artifactId!;
 assert.equal(await artifactText(id,f.env),'\uFEFF{{env:NOT_A_REAL_SECRET}} literal');
 await assert.rejects(artifactText(id,{...f.env,cwd:join(f.cwd,'another-project')}));
 f.env.boundary={available:true,roots:[namespaceRoot()]};await assert.rejects(artifactText(id,f.env));
});
test('conversion failures retain immutable originals; cancellation kills owned work and publishes no derived artifact',async t=>{
 const f=await fixture(t);await writeFile(join(f.cwd,'broken.zip'),'not a ZIP');
 const failed=await f.fetch({filePath:'broken.zip',operation:'zip-list'});assert.equal(failed.details.code,'conversion_failed');assert.deepEqual(await f.bytes(failed.details.artifactId!),Buffer.from('not a ZIP'));
 const previous=process.env.WEB_SURFER_PYTHON;
 try{process.env.WEB_SURFER_PYTHON=join(f.cwd,'missing-python');const unavailable=await f.fetch({filePath:'report.pdf',view:'artifact'});assert.equal(unavailable.details.code,'conversion_failed');assert.deepEqual(await f.bytes(unavailable.details.artifactId!),await readFile(join(f.cwd,'report.pdf')));}finally{if(previous===undefined)delete process.env.WEB_SURFER_PYTHON;else process.env.WEB_SURFER_PYTHON=previous;}
 const marker=join(f.cwd,'converter-started'),wrapper=join(f.cwd,'python-wrapper');
 await writeFile(wrapper,`#!/bin/bash\nprintf '%s\\n%s\\n' "$$" "$3" > '${marker}.tmp'\nmv '${marker}.tmp' '${marker}'\nexec '${conversionPython()}' "$@"\n`,{mode:0o700});
 const old=process.env.WEB_SURFER_PYTHON;process.env.WEB_SURFER_PYTHON=wrapper;
 const controller=new AbortController();f.env.signal=controller.signal;
 const started=new Promise<void>(resolve=>{const watcher=watch(f.cwd,()=>{if(existsSync(marker)){watcher.close();resolve();}});});
 try{const pending=f.fetch({filePath:'report.pdf',view:'artifact'});await started;const [pidText,input]= (await readFile(marker,'utf8')).trim().split('\n');const pid=Number(pidText);assert.ok(pid>0);controller.abort();const result=await pending;assert.equal(result.details.code,'cancelled');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(existsSync(dirname(input!)),false);const root=join(namespaceRoot(),projectHash(f.cwd));for(const key of await readdir(root)){for(const entry of await readdir(join(root,key))){assert.ok(!entry.includes('.staging-'));if(entry!=='latest'){const meta=await readArtifactMeta(projectHash(f.cwd),key,entry);assert.notEqual(meta?.sourceKind,'derived');}}}}finally{if(old===undefined)delete process.env.WEB_SURFER_PYTHON;else process.env.WEB_SURFER_PYTHON=old;}
});
