import path from 'node:path';
import { publishArtifact, readArtifactMeta, readSourceBytes, readLatest, markLatest, isExpired, requestDir, type ArtifactMeta } from './artifacts.ts';
import { convertLocal, ConversionError, type ConversionInfo } from './conversion.ts';
import { sha256Hex, projectHash } from './identity.ts';
import { validateBoundary } from './policy.ts';
import { validateOrigin } from './transport.ts';
import { TemplateError } from './templates.ts';
import type { FetchEnvironment, FetchRequest } from './fetchcore.ts';

export function artifactFilename(meta:ArtifactMeta):string {
 if(meta.provenance?.member)return meta.provenance.member.name;
 if(meta.filePath)return path.basename(meta.filePath);
 try{return path.posix.basename(new URL(meta.finalUrl??meta.sourceUrl??'').pathname)||'source';}catch{return 'source';}
}
async function checkAccess(meta:ArtifactMeta,env:FetchEnvironment):Promise<void>{
 env.signal?.throwIfAborted();
 await validateBoundary(env.boundary,requestDir(projectHash(env.cwd),meta.requestKey),env.signal);
 if(meta.sourceUrl){if(env.config.invalid)throw new TemplateError('Artifact origin configuration is invalid');const cfg=env.config.config!.fetch;await validateOrigin(meta.sourceUrl,cfg.privateNetworks,env.lookupImpl);if(meta.finalUrl&&meta.finalUrl!==meta.sourceUrl)await validateOrigin(meta.finalUrl,cfg.privateNetworks,env.lookupImpl);}
 env.signal?.throwIfAborted();
}
export async function artifactText(id:string,env:FetchEnvironment):Promise<string>{
 try{
  if(!/^[a-f0-9]{32}-[a-z0-9]+$/.test(id))throw new Error('Invalid artifact identity');
  const key=id.slice(0,id.indexOf('-')),project=projectHash(env.cwd);
  const meta=await readArtifactMeta(project,key,id);
  if(!meta||isExpired(meta)||meta.sizeCapped||meta.artifactId!==id)throw new Error('Artifact unavailable in this project');
  await checkAccess(meta,env);
  const bytes=await readSourceBytes(project,key,id);env.signal?.throwIfAborted();
  if(bytes===undefined)throw new Error('Artifact source unavailable');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 }catch(error){env.signal?.throwIfAborted();throw new TemplateError(`Artifact reference ${id} failed: ${error instanceof Error?error.message:String(error)}`);}
}
async function publish(parent:ArtifactMeta,bytes:Buffer,info:ConversionInfo,env:FetchEnvironment,parentBytes:Buffer,cacheKey?:string):Promise<ArtifactMeta>{
 const project=projectHash(env.cwd),key=cacheKey??sha256Hex(`${parent.artifactId}\n${info.operation}\n${JSON.stringify(info.member??null)}`).slice(0,32);
 return publishArtifact(project,key,{
  projectHash:project,requestKey:key,sourceKind:info.operation==='zip-member'?'zip-member':'derived',
  sourceUrl:parent.sourceUrl,finalUrl:parent.finalUrl,filePath:parent.filePath,method:parent.method,httpStatus:parent.httpStatus,
  contentType:info.operation==='zip-member'?undefined:info.operation==='zip-list'?'application/json':'text/markdown; charset=utf-8',
  sizeBytes:bytes.length,provenance:{sourceArtifactId:parent.artifactId,sourceSha256:sha256Hex(parentBytes),operation:info.operation,engine:info.engine,...(info.engineVersion?{engineVersion:info.engineVersion}:{}),...(info.member??parent.provenance?.member?{member:info.member??parent.provenance?.member}:{}),...(info.memberCount!==undefined?{memberCount:info.memberCount}:{})}
 },bytes,{signal:env.signal,validate:absolute=>validateBoundary(env.boundary,absolute,env.signal)});
}
export async function deriveArtifact(parent:ArtifactMeta,bytes:Buffer,request:FetchRequest,env:FetchEnvironment):Promise<ArtifactMeta>{
 await checkAccess(parent,env);
 const project=projectHash(env.cwd),cacheKey=sha256Hex(`${parent.artifactId}\nmarkitdown-local-documents-0.1.9\n${request.operation??'convert'}\n${request.memberIndex??''}`).slice(0,32);
 const cachedId=await readLatest(project,cacheKey);
 if(cachedId){const cached=await readArtifactMeta(project,cacheKey,cachedId);if(cached&&!isExpired(cached))return cached;}
 const complete=async(result:ArtifactMeta)=>{await markLatest(project,cacheKey,result.artifactId,{signal:env.signal,validate:absolute=>validateBoundary(env.boundary,absolute,env.signal)});return result;};
 const options={signal:env.signal,validate:(directory:string)=>validateBoundary(env.boundary,directory,env.signal)};
 if(request.operation==='zip-list'){
  const listed=await convertLocal(bytes,'zip-list',{},options);
  return complete(await publish(parent,listed.bytes,listed.info,env,bytes,cacheKey));
 }
 if(request.memberIndex!==undefined){
  const selected=await convertLocal(bytes,'zip-member',{member:request.memberIndex},options);
  parent=await publish(parent,selected.bytes,selected.info,env,bytes);bytes=selected.bytes;
  if(/\.zip$/i.test(artifactFilename(parent)))return parent;
 }
 try {
  const converted=await convertLocal(bytes,'convert',{filename:artifactFilename(parent),mimetype:parent.contentType},options);
  return complete(await publish(parent,converted.bytes,converted.info,env,bytes,cacheKey));
 } catch(error) {if(error instanceof ConversionError)error.artifact=parent;throw error;}
}
