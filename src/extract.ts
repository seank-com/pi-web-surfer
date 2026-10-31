import {convertLocal} from './conversion.ts';
// Lossless decoding and a thin official HTML adapter; no handwritten conversion.
export async function htmlToMarkdown(html:string,signal?:AbortSignal):Promise<string>{
 const result=await convertLocal(Buffer.from(html),'convert',{filename:'source.html',mimetype:'text/html'},{signal});
 return result.bytes.toString('utf8');
}
export interface TextRepresentation { kind: 'text'; text: Buffer }
export interface BinaryRepresentation { kind: 'binary'; contentType?: string; sizeBytes: number }
export type Representation = TextRepresentation | BinaryRepresentation;
export interface RepresentInput { bytes: Buffer; contentType?: string; sourcePath?: string }
export function isBinaryContent(contentType: string|undefined, bytes: Buffer): boolean {
 const ct=contentType?.toLowerCase().split(';')[0]?.trim()??'';
 return ['image/','audio/','video/'].some(prefix=>ct.startsWith(prefix))||['application/zip','application/gzip','application/x-gzip','application/x-bzip2','application/x-7z-compressed','application/octet-stream','application/pdf','application/wasm'].includes(ct)||bytes.subarray(0,8192).includes(0);
}
export function isHtmlContent(contentType:string|undefined, sourcePath:string|undefined):boolean {
 return ['text/html','application/xhtml+xml'].includes(contentType?.toLowerCase().split(';')[0]?.trim()??'')||/\.html?$/i.test(sourcePath??'');
}
export async function represent(input:RepresentInput,mode:'readable'|'raw'):Promise<Representation> {
 if(isBinaryContent(input.contentType,input.bytes))return{kind:'binary',contentType:input.contentType,sizeBytes:input.bytes.length};
 let decoded:string;
 try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(input.bytes);}
 catch{return{kind:'binary',contentType:input.contentType,sizeBytes:input.bytes.length};}
 return{kind:'text',text:Buffer.from(mode==='readable'&&isHtmlContent(input.contentType,input.sourcePath)?await htmlToMarkdown(decoded):decoded,'utf8')};
}
