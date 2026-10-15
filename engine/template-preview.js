import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {inflateSync} from 'node:zlib';
import {iterateTemplate,TEMPLATE_LIMITS,checkTemplateCancellation} from './template-stream.js';
import {safePath} from './paths.js';import {externalParent} from './build-archive.js';import {requireThat} from './errors.js';import {parseNBT} from './nbt.js';import {decodeSection} from './chunks.js';import {terrainColor} from './terrain-colors.js';
const RECORD_BYTES=24,INDEX_BUDGET=256*1024*1024,INDEX_NAME=/^[a-f0-9]{64}\.idx$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const stamp=file=>{const s=fs.lstatSync(file,{bigint:true});requireThat(s.isFile()&&!s.isSymbolicLink(),'TEMPLATE_FILE','Choose a regular template file.');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
function read(fd,length,position){const b=Buffer.alloc(length);requireThat(fs.readSync(fd,b,0,length,position)===length,'TEMPLATE_CHANGED','Template preview data changed or is truncated.');return b;}
export function templateSchema(file){const root=fs.realpathSync(path.dirname(file)),fd=fs.openSync(safePath(root,path.basename(file)),fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const magic=read(fd,9,0).toString();requireThat(['WRBUILD1\n','WRBUILD2\n'].includes(magic),'TEMPLATE_FORMAT','Unrecognized .wrbuild format.');return magic==='WRBUILD2\n'?2:1;}finally{fs.closeSync(fd);}}
function previewDirectory(directory,worlds){let ancestor=path.resolve(directory);while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);externalParent(ancestor,worlds);fs.mkdirSync(directory,{recursive:true});return externalParent(directory,worlds);}
function trim(directory,needed){const entries=[];let bytes=0;for(const e of fs.readdirSync(directory,{withFileTypes:true})){if(!e.isFile()||!INDEX_NAME.test(e.name))continue;const s=fs.lstatSync(path.join(directory,e.name));entries.push({name:e.name,bytes:s.size,time:s.mtimeMs});bytes+=s.size;}for(const e of entries.sort((a,b)=>a.time-b.time)){if(bytes+needed<=INDEX_BUDGET)break;fs.unlinkSync(path.join(directory,e.name));bytes-=e.bytes;}}
/** Fully validate once, then retain a small seek index on disk, never decoded build arrays. */
export function openTemplatePreview(directory,file,options={}){
 stamp(file);const root=previewDirectory(directory,options.worlds??[]),source=fs.realpathSync(file),sourceStamp=stamp(source);requireThat(templateSchema(source)===2,'TEMPLATE_FORMAT','Use the legacy preview for v1 templates.');
 const id=hash(JSON.stringify([source,sourceStamp])),temporary=path.join(root,`.${randomUUID()}.tmp`),fd=fs.openSync(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 let out,position,header,summary,digest,chunks=0,end=0;
 try{
  position=13+read(fd,4,9).readUInt32BE(0);out=fs.openSync(temporary,'wx',0o600);
  for(const event of iterateTemplate(source,{...options,onProgress:p=>{if(p.phase==='Reading template'&&Number.isSafeInteger(p.bytes))end=p.bytes;options.onProgress?.(p);}})){
   checkTemplateCancellation(options);
   if(event.type==='header')header=event.header;
   if(event.type==='chunk'){
    requireThat((chunks+1)*RECORD_BYTES<=INDEX_BUDGET,'TEMPLATE_PREVIEW_BUDGET','This template needs more than 256 MiB of preview index space. Its archive is retained; use a larger-index adapter for preview.');
    requireThat(end>position&&end-position<=TEMPLATE_LIMITS.compressedFrame+41,'TEMPLATE_INDEX','Invalid preview frame offset.');
    const record=Buffer.alloc(RECORD_BYTES);record.writeInt32BE(event.chunk.x,0);record.writeInt32BE(event.chunk.z,4);record.writeBigUInt64BE(BigInt(position),8);record.writeUInt32BE(end-position,16);fs.writeSync(out,record);chunks++;position=end;
   }
   if(event.type==='end'){summary=event.summary;digest=event.digest;}
  }
  requireThat(digest&&stamp(source)===sourceStamp,'TEMPLATE_CHANGED','Template changed during preview indexing.');fs.fsyncSync(out);fs.closeSync(out);out=undefined;
  trim(root,chunks*RECORD_BYTES);fs.renameSync(temporary,path.join(root,id+'.idx'));
  return {schema:2,file:source,id:path.basename(source),name:path.basename(source).slice(0,-8),header,summary,digest,preview:{id,sourceStamp,chunks,file:source,header,digest}};
 }finally{fs.closeSync(fd);if(out!==undefined)fs.closeSync(out);try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function findFrame(fd,count,x,z){let lo=0,hi=count-1;while(lo<=hi){const mid=Math.floor((lo+hi)/2),r=read(fd,RECORD_BYTES,mid*RECORD_BYTES),cx=r.readInt32BE(0),cz=r.readInt32BE(4),compare=cz-z||cx-x;if(compare===0)return {position:Number(r.readBigUInt64BE(8)),length:r.readUInt32BE(16)};if(compare<0)lo=mid+1;else hi=mid-1;}return null;}
function frameChunk(fd,frame){
 requireThat(Number.isSafeInteger(frame.position)&&frame.position>=13&&frame.length>41&&frame.length<=TEMPLATE_LIMITS.compressedFrame+41,'TEMPLATE_INDEX','Invalid preview frame index.');
 const e=read(fd,41,frame.position);requireThat(e[0]===1&&e.readUInt32BE(1)+41===frame.length,'TEMPLATE_INDEX','Preview frame index does not match archive.');const expanded=e.readUInt32BE(5);
 requireThat(expanded>0&&expanded<=TEMPLATE_LIMITS.frame,'TEMPLATE_LIMIT','Preview frame exceeds safety budget.');const packed=read(fd,frame.length-41,frame.position+41),inflated=inflateSync(packed,{maxOutputLength:expanded,info:true}),raw=inflated.buffer;
 requireThat(raw.length===expanded&&inflated.engine.bytesWritten===packed.length&&hash(raw)===e.subarray(9).toString('hex'),'TEMPLATE_CHECKSUM','Preview frame checksum failed.');
 const length=raw.readUInt32BE(0);requireThat(length>0&&length<=TEMPLATE_LIMITS.metadata&&length+4<=raw.length,'TEMPLATE_FORMAT','Invalid preview frame metadata.');
 const chunk=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(4,4+length)));let cursor=4+length;
 const take=n=>{requireThat(Number.isSafeInteger(n)&&n>=0&&cursor+n<=raw.length,'TEMPLATE_FORMAT','Invalid preview record length.');const b=raw.subarray(cursor,cursor+n);cursor+=n;return b;};
 chunk.sections=chunk.sections.map(s=>({...s,mask:s.mask==='full'?Buffer.alloc(512,255):take(512)}));
 const region=take(chunk.records.region);return {...chunk,region};
}
export function templatePreviewSlice(directory,context,request,options={}){
 requireThat(context&&/^[a-f0-9]{64}$/.test(context.id)&&context.header?.schema===2,'TEMPLATE_PREVIEW','Open a validated template first.');
 requireThat(Number.isInteger(request?.y)&&Math.abs(request.y)<=30000000&&Array.isArray(request.chunks)&&request.chunks.length>0&&request.chunks.length<=16&&request.chunks.every(c=>Number.isInteger(c.x)&&Number.isInteger(c.z)&&Math.abs(c.x)<=1875000&&Math.abs(c.z)<=1875000),'TEMPLATE_SLICE_LIMIT','A preview slice covers at most 16 valid chunks.');
 requireThat(stamp(context.file)===context.sourceStamp,'TEMPLATE_CHANGED','Template changed. Reopen it before previewing.');
 const index=safePath(directory,context.id+'.idx'),indexStat=fs.lstatSync(index);requireThat(indexStat.size===context.chunks*RECORD_BYTES,'TEMPLATE_INDEX','Preview index was evicted or damaged. Reopen the template.');
 const fd=fs.openSync(context.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),ix=fs.openSync(index,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),tiles=[];
 try{
  for(const {x,z} of request.chunks){
   checkTemplateCancellation(options);const frame=findFrame(ix,context.chunks,x,z),selected=new Uint8Array(256),base={x,z,y:request.y,selected};
   if(!frame){tiles.push({...base,status:'excluded'});continue;}
   const chunk=frameChunk(fd,frame);requireThat(chunk.x===x&&chunk.z===z,'TEMPLATE_INDEX','Preview index coordinates disagree with template.');
   const sy=Math.floor(request.y/16),mask=chunk.sections.find(s=>s.y===sy)?.mask;if(!mask){tiles.push({...base,status:'excluded'});continue;}
   const planeOffset=((request.y%16+16)%16)*256;if(!mask.subarray(planeOffset/8,planeOffset/8+32).some(b=>b!==0)){tiles.push({...base,status:'excluded'});continue;}
   const nbt=parseNBT(chunk.region),section=nbt.sections.find(s=>s.Y===sy),decoded=decodeSection(section),ids=new Uint16Array(256),rgba=new Uint8ClampedArray(1024),offset=((request.y%16+16)%16)*256;
   for(let i=0;i<256;i++){const at=offset+i;selected[i]=Boolean(mask[at>>3]&(1<<(at&7)));ids[i]=decoded.indices[at];const rgb=terrainColor(decoded.palette[ids[i]].Name).rgb;rgba.set([(rgb>>16)&255,(rgb>>8)&255,rgb&255,255],i*4);}
   tiles.push({...base,status:'ready',ids,rgba,palette:decoded.palette});
  }
  requireThat(stamp(context.file)===context.sourceStamp,'TEMPLATE_CHANGED','Template changed during preview. Reopen it.');return {tiles,y:request.y};
 }finally{fs.closeSync(ix);fs.closeSync(fd);}
}
