import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {createServer} from 'node:http';
const root=await realpath(await mkdtemp(join(tmpdir(),'web-native-conversion-')));
process.chdir(root);process.env.HOME=root;process.env.TMPDIR=join(root,'tmp');await mkdir(process.env.TMPDIR,{mode:0o700});
const host=process.env.PI_CODING_AGENT_PACKAGE!,data=process.env.DATASTORE_PACKAGE!;
assert.ok(host&&data&&process.env.WEB_SURFER_PYTHON,'Explicit host, companion and local conversion interpreter required');
const sdk=await import(pathToFileURL(join(host,'dist/index.js')).href);
const ai=await import(pathToFileURL(join(dirname(findPackageJSON('@earendil-works/pi-ai',pathToFileURL(join(host,'package.json')))!),'dist/index.js')).href);
const entry=process.env.WEB_SURFER_ENTRY??new URL('../../src/index.ts',import.meta.url).href;
const documents=fileURLToPath(new URL('./documents.py',import.meta.url));
const summary=Array.from({length:300},(_,i)=>`word${i+1}`).join(' ');
try{
 for(const order of ['web-first','datastore-first']){
  const cwd=join(root,order),profile=join(root,order+'-profile');await mkdir(cwd);await mkdir(profile);await mkdir(join(cwd,'notes'));
  execFileSync(process.env.WEB_SURFER_PYTHON,[documents,cwd],{stdio:'pipe'});
  const pdf=await readFile(join(cwd,'report.pdf'));let posted:any;
  const server=createServer(async(req,res)=>{
   if(req.url==='/report.pdf'){res.setHeader('content-type','application/pdf');res.end(pdf);return;}
   assert.equal(req.url,'/api/generate');assert.equal(req.method,'POST');const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);posted=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',response:summary,done:true}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  await mkdir(join(cwd,'.pi/markdown-datastore'),{recursive:true,mode:0o700});
  await writeFile(join(cwd,'.pi/markdown-datastore/config.json'),JSON.stringify({schemaVersion:1,defaults:{maxResultBytes:4096,maxResultLines:100,operationTimeoutMs:3000},qmd:{enabled:false,installation:{executable:'qmd'},minimumVersion:'2.8.3'},stores:{fixture:{root:'notes',include:['**/*.md'],exclude:[],maxFileBytes:4096,search:{defaultMode:'lexical',qmdCollection:'fixture'}}}}),{mode:0o600});
  await mkdir(join(cwd,'.pi/web-surfer'),{recursive:true,mode:0o700});await writeFile(join(cwd,'.pi/web-surfer/config.json'),JSON.stringify({fetch:{privateNetworks:'allow'}}),{mode:0o600});
  await writeFile(join(cwd,'summarize.json'),'{"model":"fixture","system":"Summarize in 300 words.","prompt":{{artifact:{{source}},json}},"stream":false}');
  const modelRuntime=await sdk.ModelRuntime.create({authPath:join(profile,'auth.json'),modelsPath:null,modelsStorePath:join(profile,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
  const provider='conversion-fixture',model={id:'fixture',name:'Fixture',api:'openai-completions',provider,baseUrl:'http://fixture.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024};
  let calls=0,convertedId='';const contexts:any[]=[],errors:string[]=[];
  modelRuntime.registerProvider(provider,{api:model.api,apiKey:'synthetic-only',baseUrl:model.baseUrl,models:[model],streamSimple:(_model:any,context:any)=>{
   const stream=ai.createAssistantMessageEventStream();
   try{
    contexts.push(structuredClone(context));assert.ok(++calls<=3,'Unexpected originating-model request');
    assert.ok(!JSON.stringify(context).includes('PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT'));
    let content:any[],stopReason='stop';
    if(calls===1){content=[{type:'toolCall',id:'convert',name:'web_fetch',arguments:{url:base+'/report.pdf',view:'artifact'}}];stopReason='toolUse';}
    else if(calls===2){const result=context.messages.find((m:any)=>m.role==='toolResult');const match=JSON.stringify(result.content).match(/artifact ([a-f0-9]{32}-[a-z0-9]+)/);assert.ok(match,JSON.stringify(result));convertedId=match[1];content=[{type:'toolCall',id:'summarize',name:'web_fetch',arguments:{url:base+'/api/generate',method:'POST',headers:{'content-type':'application/json'},body:`{{template:summarize.json,{"source":"${convertedId}"}}}`}}];stopReason='toolUse';}
    else content=[{type:'text',text:'Summary response received.'}];
    const message={role:'assistant',content,api:model.api,provider,model:model.id,usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};stream.push({type:'done',reason:stopReason,message});stream.end();
   }catch(error){errors.push(String(error));stream.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'error',errorMessage:String(error),timestamp:Date.now()}});stream.end();}
   return stream;
  }});
  const web=join(cwd,'web.ts'),datastore=join(cwd,'data.ts');
  await writeFile(web,`import {createWebSurferExtension} from ${JSON.stringify(entry)}; export default createWebSurferExtension();`);
  await writeFile(datastore,`import {createMarkdownDatastoreExtension} from ${JSON.stringify(pathToFileURL(join(data,'dist/index.js')).href)}; export default createMarkdownDatastoreExtension({projectRoot:${JSON.stringify(cwd)},configPath:${JSON.stringify(join(cwd,'.pi/markdown-datastore/config.json'))}});`);
  const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'},{projectTrusted:true});
  let session:any;
  try{
   const loader=new sdk.DefaultResourceLoader({cwd,agentDir:profile,settingsManager:settings,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:order==='web-first'?[web,datastore]:[datastore,web]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
   ({session}=await sdk.createAgentSession({cwd,agentDir:profile,model,modelRuntime,resourceLoader:loader,settingsManager:settings,tools:['web_fetch']}));await session.bindExtensions({onError:(error:any)=>errors.push(String(error))});
   await session.prompt('Download the synthetic PDF, convert it without showing its text, and send its converted artifact directly through the template to the synthetic summarizer.');
   assert.deepEqual(errors,[]);assert.equal(calls,3);assert.ok(posted.prompt.includes('PDF-END-COMPLETE'));assert.ok(posted.prompt.length>51200);assert.equal(posted.system,'Summarize in 300 words.');
   assert.ok(!JSON.stringify(contexts).includes('PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT'));assert.ok(!JSON.stringify(session.messages).includes('PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT'));assert.ok(JSON.stringify(session.messages).includes(summary));
   const key=convertedId.split('-')[0];const {createHash}=await import('node:crypto');const project=createHash('sha256').update(cwd).digest('hex').slice(0,16);const artifact=join(process.env.TMPDIR!,'web-surfer',project,key,convertedId);
   assert.equal(posted.prompt,(await readFile(join(artifact,'data.bin'))).toString('utf8'));
   const meta=JSON.parse(await readFile(join(artifact,'meta.json'),'utf8'));const source=meta.provenance.sourceArtifactId;assert.deepEqual(await readFile(join(process.env.TMPDIR!,'web-surfer',project,source.split('-')[0],source,'data.bin')),pdf);
  }finally{await session?.abort();session?.dispose();modelRuntime.unregisterProvider(provider);await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
 console.log('PASS: registered native web_fetch uses full converted PDF directly in an Ollama template; no PDF source in originating model context; both public companion orders');
}finally{await rm(root,{recursive:true,force:true});}
