import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ConversionError extends Error { artifact?: import('./artifacts.ts').ArtifactMeta; }
export interface ConversionInfo {
 operation: string; engine: string; engineVersion?: string; title?: string;
 memberCount?: number; member?: { index: number; name: string; declaredSize: string };
}
export function conversionPython(): string {
 const local = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
 return process.env.WEB_SURFER_PYTHON ?? (existsSync(local) ? local : 'python3');
}
/** One owned subprocess and temporary directory, with no timer or buffer cap. */
export async function convertLocal(bytes: Buffer, operation: 'convert'|'zip-list'|'zip-member', info: {filename?: string; mimetype?: string; member?: number}, options: {signal?: AbortSignal; validate?: (directory: string)=>Promise<void>} = {}): Promise<{bytes: Buffer; info: ConversionInfo}> {
 const {signal}=options;
 signal?.throwIfAborted();
 const directory=path.join(await realpath(os.tmpdir()),'web-surfer-conversion-'+randomUUID());
 await options.validate?.(directory);
 await mkdir(directory,{mode:0o700});
 try {
  const input=path.join(directory,'input.bin'),output=path.join(directory,'output.bin');
  await writeFile(input,bytes,{mode:0o600,signal});signal?.throwIfAborted();
  const result=await new Promise<ConversionInfo>((resolve,reject)=>{
   const child=spawn(conversionPython(),[fileURLToPath(new URL('../python/bridge.py',import.meta.url)),operation,input,output,JSON.stringify(info)],{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
   const stdout:Buffer[]=[],stderr:Buffer[]=[];
   const cancel=()=>{if(child.pid){try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')reject(error);}}};
   child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
   child.once('error',error=>{signal?.removeEventListener('abort',cancel);reject(new ConversionError(`Cannot start local converter: ${error.message}. Set WEB_SURFER_PYTHON to the interpreter with python/requirements.lock installed.`));});
   child.once('close',code=>{
    signal?.removeEventListener('abort',cancel);
    if(signal?.aborted){reject(signal.reason);return;}
    let payload:ConversionInfo & {error?:string;message?:string};
    try{payload=JSON.parse(Buffer.concat(stdout).toString('utf8'));}catch{reject(new ConversionError(`Local converter failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`));return;}
    if(code!==0||payload.error){reject(new ConversionError(`${payload.error}: ${payload.message}`));return;}resolve(payload);
   });
   signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
  signal?.throwIfAborted();const converted=await readFile(output,{signal});signal?.throwIfAborted();return{bytes:converted,info:result};
 } finally {await rm(directory,{recursive:true,force:true});}
}
