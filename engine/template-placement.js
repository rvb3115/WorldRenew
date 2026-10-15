import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { externalParent, sha } from './build-archive.js';
import { createChunkReader, stateKey, isAir, isFluid } from './chunks.js';
import { placeableState } from './copy-placement.js';
import { DIMENSIONS } from './dimensions.js';
import { requireThat } from './errors.js';
import { readBounded, safePath } from './paths.js';
import { createVerifiedCopy, inventory } from './safety.js';
import { iterateTemplate, checkTemplateCancellation } from './template-stream.js';
import { readWorldConfiguration } from './world-configuration.js';
import { inspectWorld } from './world.js';
import { validateTemplatePlacementHeader, validateTemplateSourceChunk, validateTemplateDestinationChunk, assertDestinationAttachmentsClear, assertDestinationCellWritable } from './template-placement-policy.js';
import { rewriteTemplateChunk } from './template-placement-chunk.js';
import { prepareTemplateRegion } from './template-placement-region.js';

const STORES = ['region', 'entities', 'poi'];
const DIRECTIONS = [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
const mod = (n, d) => (n % d + d) % d;
const coordKey = (x,z) => `${x}_${z}`;
const relativeRegion = (dimension,x,z) => path.join(dimension.path === '.' ? '' : dimension.path, 'region', `r.${Math.floor(x/32)}.${Math.floor(z/32)}.mca`);
const cancel = options => checkTemplateCancellation(options);
function progress(options, value) { cancel(options); options.onProgress?.(value); cancel(options); }
function stamp(root, relative) {
  try { const s = fs.statSync(safePath(root, relative), {bigint:true}); requireThat(s.isFile(), 'PLACEMENT_FILE', 'Placement input must be a regular file.'); return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function absoluteStamp(file) { return stamp(path.dirname(path.resolve(file)), path.basename(file)); }
// Scratch evidence is authenticated by a key that never leaves this operation.
// A progress/cancellation callback may run between creating and consuming it.
function authentication(plan, file, bytes) {
  return createHmac('sha256',plan.secret).update(path.relative(plan.directory,file)+'\0').update(bytes).digest('hex');
}
function writePlanFile(plan,file,bytes,exclusive=true) {
  safePath(plan.directory,path.relative(plan.directory,path.dirname(file)));
  const flags=fs.constants.O_WRONLY|fs.constants.O_CREAT|(exclusive?fs.constants.O_EXCL:fs.constants.O_TRUNC)|(fs.constants.O_NOFOLLOW||0);
  for(const[target,data]of[[file,bytes],[file+'.auth',authentication(plan,file,bytes)]]) {
    const fd=fs.openSync(target,flags,0o600);try{fs.writeFileSync(fd,data);}finally{fs.closeSync(fd);}
  }
}
function readPlanFile(plan,file,limit) {
  const bytes=readBounded(plan.directory,path.relative(plan.directory,file),limit);
  const signature=readBounded(plan.directory,path.relative(plan.directory,file+'.auth'),64).toString();
  requireThat(authentication(plan,file,bytes)===signature,'PLACEMENT_PLAN','Private placement evidence changed after validation.');return bytes;
}
// A fixed-size multiset checksum binds all contributions without retaining a
// template-sized Map; count checks also detect missing/replayed signed plans.
const SUM_MASK=(1n<<256n)-1n;
function contribution(x,z,sourceKey) {return BigInt('0x'+sha(Buffer.from(JSON.stringify({x,z,sourceKey}))));}
function appendObservation(plan,value) {
  const line=JSON.stringify(value)+'\n';plan.journalHash.update(line);
  const fd=fs.openSync(plan.journal,fs.constants.O_WRONLY|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW||0));
  try{fs.writeFileSync(fd,line);}finally{fs.closeSync(fd);}
}
function* lines(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),buffer=Buffer.alloc(65536),decoder=new StringDecoder('utf8'); let pending='';
  try { for (;;) { const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;pending+=decoder.write(buffer.subarray(0,n));let end;while((end=pending.indexOf('\n'))!==-1){requireThat(end<65536,'PLACEMENT_PLAN','Oversized plan journal entry.');yield JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);}requireThat(pending.length<65536,'PLACEMENT_PLAN','Oversized plan journal entry.');}requireThat(!pending.length,'PLACEMENT_PLAN','Truncated plan journal.'); }
  finally { fs.closeSync(fd); }
}
function* directoryEntries(directory) { const h=fs.opendirSync(directory);try{for(let e;(e=h.readSync());)yield e;}finally{h.closeSync();} }
function journalPaths(dimension,x,z) { return STORES.flatMap(store=>{const folder=path.join(dimension.path==='.'?'':dimension.path,store);return[path.join(folder,`r.${Math.floor(x/32)}.${Math.floor(z/32)}.mca`),path.join(folder,`c.${x}.${z}.mcc`)];}); }
function readView(world,dimension,x,z,plan,hash,options) {
  cancel(options);
  const observations=journalPaths(dimension,x,z).map(relative=>[relative,stamp(world.root,relative)]);
  const reader=createChunkReader(world.root,dimension),records=STORES.map(store=>reader.read(x,z,store));reader.verifyStable();
  const view=validateTemplateDestinationChunk(records[0],records[1],records[2],x,z);
  for(const[relative,expected]of observations)requireThat(stamp(world.root,relative)===expected,'PLACEMENT_STALE','Destination changed during placement review.');
  appendObservation(plan,observations);
  hash.update(JSON.stringify({x,z,records:records.map(record=>record?sha(record.raw):null)}));
  // The old region writer also refuses large regions and external replacements.
  const relative=relativeRegion(dimension,x,z),file=safePath(world.root,relative),fd=fs.openSync(file,'r');
  try { requireThat(fs.fstatSync(fd).size<=256*1024*1024,'PLACEMENT_REGION_LIMIT','Placement retains the 256 MiB per-region safety limit.');const b=Buffer.alloc(4);requireThat(fs.readSync(fd,b,0,4,(mod(x,32)+mod(z,32)*32)*4)===4,'PLACEMENT_STALE','Region header changed.');const offset=(b.readUInt32BE()>>>8)*4096,m=Buffer.alloc(1);requireThat(fs.readSync(fd,m,0,1,offset+4)===1&&!(m[0]&128),'PLACEMENT_EXTERNAL','Replacing external terrain records is not supported by this placement adapter.'); }
  finally { fs.closeSync(fd); }
  return view;
}
function verifyJournal(world,plan,options) {
  const hash=createHash('sha256');
  for(const observations of lines(plan.journal)){
    hash.update(JSON.stringify(observations)+'\n');
    for(const[relative,expected]of observations){cancel(options);requireThat(stamp(world.root,relative)===expected,'PLACEMENT_STALE','Destination storage changed during placement review.');}
  }
  requireThat(hash.digest('hex')===plan.journalHash.copy().digest('hex'),'PLACEMENT_PLAN','Placement observation journal changed.');
}
function markChunk(plan,x,z,sourceKey) {
  safePath(plan.directory,'regions');
  const directory=path.join(plan.regions,coordKey(Math.floor(x/32),Math.floor(z/32)));fs.mkdirSync(directory,{recursive:true,mode:0o700});
  safePath(plan.directory,path.relative(plan.directory,directory));
  const file=path.join(directory,`${coordKey(x,z)}.patches`),fresh=!fs.existsSync(file);
  let text=fresh?'':readPlanFile(plan,file,1024).toString();
  if(sourceKey!==undefined){text+=`${sourceKey}\n`;plan.contributions=(plan.contributions+contribution(x,z,sourceKey))&SUM_MASK;plan.contributionCount++;}
  if(fresh||sourceKey!==undefined)writePlanFile(plan,file,text,fresh);
  return fresh;
}
function saveSource(plan,chunk) {
  const key=coordKey(chunk.x,chunk.z);safePath(plan.directory,'sources');
  fs.writeFileSync(path.join(plan.sources,`${key}.nbt`),chunk.records.region,{flag:'wx',mode:0o600});
  writePlanFile(plan,path.join(plan.sources,`${key}.json`),JSON.stringify({x:chunk.x,z:chunk.z,rawSha256:sha(chunk.records.region),sections:chunk.sections.map(s=>({y:s.y,mask:s.mask.toString('base64')}))}));
  return key;
}
function* patchesFor(plan,regionDirectory,x,z) {
  const text=readPlanFile(plan,path.join(regionDirectory,`${coordKey(x,z)}.patches`),1024).toString('utf8'),keys=text.split('\n').filter(Boolean);
  requireThat(keys.length<=4&&new Set(keys).size===keys.length,'PLACEMENT_PLAN','Invalid sparse chunk contributions.');
  for(const key of keys){requireThat(/^-?\d+_-?\d+$/.test(key),'PLACEMENT_PLAN','Invalid source contribution.');const metadata=JSON.parse(readPlanFile(plan,path.join(plan.sources,`${key}.json`),65536)),raw=readBounded(plan.sources,`${key}.nbt`,32*1024*1024);requireThat(sha(raw)===metadata.rawSha256,'PLACEMENT_PLAN','Cached template record changed after validation.');yield{offset:plan.offset,chunk:{...metadata,sections:metadata.sections.map(s=>({y:s.y,mask:Buffer.from(s.mask,'base64')})),records:{region:raw}}};}
}
function* regions(plan) {
  for(const entry of directoryEntries(plan.regions)){
    requireThat(entry.isDirectory()&&!entry.isSymbolicLink()&&/^-?\d+_-?\d+$/.test(entry.name),'PLACEMENT_PLAN','Invalid private region plan.');
    const [regionX,regionZ]=entry.name.split('_').map(Number),directory=path.join(plan.regions,entry.name),chunks=[];
    for(const child of directoryEntries(directory))if(child.name.endsWith('.patches')){
      requireThat(child.isFile()&&!child.isSymbolicLink()&&/^-?\d+_-?\d+\.patches$/.test(child.name)&&chunks.length<1024,'PLACEMENT_PLAN','Invalid or excessive region chunk plans.');
      const [x,z]=child.name.slice(0,-8).split('_').map(Number);requireThat(Math.floor(x/32)===regionX&&Math.floor(z/32)===regionZ,'PLACEMENT_PLAN','Chunk plan belongs to another region.');chunks.push({x,z,slot:mod(x,32)+mod(z,32)*32});
    }
    requireThat(chunks.length>0,'PLACEMENT_PLAN','Empty private region plan.');chunks.sort((a,b)=>a.slot-b.slot);yield{regionX,regionZ,directory,chunks};
  }
}
function verifyContributions(plan,expectedChunks) {
  let sum=0n,count=0n,chunks=0n;
  for(const region of regions(plan))for(const{x,z}of region.chunks){
    chunks++;const keys=readPlanFile(plan,path.join(region.directory,`${coordKey(x,z)}.patches`),1024).toString().split('\n').filter(Boolean);
    requireThat(keys.length<=4&&new Set(keys).size===keys.length,'PLACEMENT_PLAN','Invalid sparse chunk contributions.');
    for(const sourceKey of keys){sum=(sum+contribution(x,z,sourceKey))&SUM_MASK;count++;}
  }
  requireThat(sum===plan.contributions&&count===plan.contributionCount&&chunks===expectedChunks,'PLACEMENT_PLAN','Sparse placement plan lost or changed selected contributions.');
}
function targetPatch(source,offset) {
  const chunks=new Map();
  for(const cell of source.blocks()){
    const x=cell.x+offset.x,y=cell.y+offset.y,z=cell.z+offset.z,cx=Math.floor(x/16),cz=Math.floor(z/16),sy=Math.floor(y/16),key=coordKey(cx,cz);
    if(!chunks.has(key))chunks.set(key,{x:cx,z:cz,sections:new Map()});const target=chunks.get(key);
    if(!target.sections.has(sy))target.sections.set(sy,new Array(4096));target.sections.get(sy)[mod(y,16)*256+mod(z,16)*16+mod(x,16)]=cell.state;
  }
  return [...chunks.values()].sort((a,b)=>a.z-b.z||a.x-b.x);
}
function* cells(target) {for(const[y,states]of target.sections)for(let i=0;i<4096;i++)if(states[i])yield{x:target.x*16+i%16,y:y*16+(i>>8),z:target.z*16+((i>>4)&15),state:states[i]};}
function contains(target,x,y,z) {return Math.floor(x/16)===target.x&&Math.floor(z/16)===target.z&&Boolean(target.sections.get(Math.floor(y/16))?.[mod(y,16)*256+mod(z,16)*16+mod(x,16)]);}
function serialCounters(value) {return Object.fromEntries(Object.entries(value).map(([key,n])=>[key,n.toString()]));}
function configurationWarnings(header,configuration){
  const notices=[...configuration.summary.notices],source=header.source.configuration;if(!source)return notices;
  if(JSON.stringify(source.fields)!==JSON.stringify(configuration.provenance.fields)||source.generationSha256!==configuration.provenance.generationSha256)notices.push('Source and destination configuration differ. Destination feature flags, generation settings and datapacks remain unchanged.');
  if(source.packFiles===null)notices.push('Template datapack payloads are not bundled or fingerprinted; placement does not install packs.');
  else if(JSON.stringify(source.packFiles)!==JSON.stringify(configuration.provenance.packFiles))notices.push('Source and destination datapack fingerprints differ; no datapacks are replaced.');return notices;
}
function createPlanDirectory(parent) {
  const directory=fs.mkdtempSync(path.join(parent,'.worldrenew-template-plan-'));
  const plan={secret:randomBytes(32),journalHash:createHash('sha256'),contributions:0n,contributionCount:0n,directory,sources:path.join(directory,'sources'),regions:path.join(directory,'regions'),journal:path.join(directory,'observations.jsonl')};
  fs.mkdirSync(plan.sources,{mode:0o700});fs.mkdirSync(plan.regions,{mode:0o700});fs.writeFileSync(plan.journal,'',{mode:0o600});return plan;
}
function preparePlan(file,destination,dimensionKey,anchor,options,parent) {
  cancel(options);const plan=createPlanDirectory(parent);
  try {
    const fingerprint=sha(readBounded(destination.root,'level.dat',16*1024*1024));requireThat(fingerprint===destination.fingerprint,'PLACEMENT_STALE','World metadata changed since inspection.');
    const configuration=readWorldConfiguration(destination.root),archiveStamp=absoluteStamp(file),hash=createHash('sha256');
    const protection=options.protection??[];requireThat(Array.isArray(protection),'PLACEMENT_PROTECTION','Invalid protection plan.');
    const protectedChunks=new Set(protection.map(p=>{requireThat(p&&typeof p.dimension==='string'&&Number.isSafeInteger(p.x)&&Number.isSafeInteger(p.z),'PLACEMENT_PROTECTION','Invalid protected chunk.');return`${p.dimension}:${p.x},${p.z}`;}));
    hash.update(JSON.stringify({world:fingerprint,configuration:configuration.digest,dimensionKey,anchor,airMode:options.airMode??'include',protection}));
    const counts=Object.fromEntries(['unchanged','placed','overwritten','carved','unknown','fluid','airVariant','skippedAir'].map(k=>[k,0n])),sourceAir={air:0n,caveAir:0n,voidAir:0n,structureVoid:0n,unknown:0n};
    let header,settings,ending,selected=0n,lightingChunks=0n,fluidFaces=0n,sourceChunks=0n;
    for(const event of iterateTemplate(file,{signal:options.signal,shouldCancel:options.shouldCancel})){
      cancel(options);
      if(event.type==='header'){header=event.header;requireThat(!header.legacySchema,'PLACEMENT_TEMPLATE','Use the existing placement route for schema-1 templates.');settings=validateTemplatePlacementHeader(header,destination,dimensionKey,anchor,options);plan.offset=settings.offset;plan.dimension=settings.dimension;continue;}
      if(event.type==='end'){ending=event;continue;}
      const chunk=event.chunk,source=validateTemplateSourceChunk(chunk,options),sourceKey=saveSource(plan,chunk);sourceChunks++;
      for(const target of targetPatch(source,settings.offset)){
        progress(options,{phase:'Preparing template placement',sourceChunks:sourceChunks.toString(),selectedBlocks:selected.toString(),x:target.x,z:target.z});
        const height=DIMENSIONS[settings.dimension.id],targetContains=(x,y,z)=>contains(target,x,y,z);
        for(let z=target.z-1;z<=target.z+1;z++)for(let x=target.x-1;x<=target.x+1;x++){
          requireThat(!protectedChunks.has(`${dimensionKey}:${x},${z}`),'PLACEMENT_PROTECTED','Placement or its one-chunk lighting border overlaps protected destination chunks.');
          const view=readView(destination,settings.dimension,x,z,plan,hash,options);assertDestinationAttachmentsClear(view,targetContains);
          const center=x===target.x&&z===target.z;
          if(markChunk(plan,x,z,center?sourceKey:undefined))lightingChunks++;
          if(Math.abs(x-target.x)+Math.abs(z-target.z)>1)continue;
          for(const cell of cells(target)){
            if(center){
              const existing=assertDestinationCellWritable(view,cell.x,cell.y,cell.z),s=cell.state;selected++;
              const airKey={'minecraft:air':'air','minecraft:cave_air':'caveAir','minecraft:void_air':'voidAir'}[s.Name];if(airKey)sourceAir[airKey]++;
              const same=stateKey(existing)===stateKey(s),skip=settings.airMode==='skip'&&isAir(s);
              if(!skip&&!same)requireThat(placeableState(existing),'PLACEMENT_DESTINATION_BLOCK',`Placement would replace unsupported destination block ${existing.Name}.`);
              const kind=skip?'skippedAir':same?'unchanged':isAir(s)&&!isAir(existing)?'carved':isFluid(s)||isFluid(existing)?'fluid':isAir(existing)&&!isAir(s)?'placed':isAir(s)&&isAir(existing)?'airVariant':'overwritten';counts[kind]++;
            }
            for(const[dx,dy,dz]of DIRECTIONS){
              const nx=cell.x+dx,ny=cell.y+dy,nz=cell.z+dz;if(ny<height.minY||ny>height.maxY||Math.floor(nx/16)!==x||Math.floor(nz/16)!==z)continue;
              const adjacent=view.block(nx,ny,nz);if(isFluid(adjacent))fluidFaces++;
            }
          }
        }
      }
    }
    requireThat(ending&&selected===BigInt(ending.summary.selectedBlocks),'PLACEMENT_PLAN','Template selection accounting failed.');
    hash.update(JSON.stringify({archive:ending.digest}));
    verifyContributions(plan,lightingChunks);
    // Preflight exact typed rewrites, including palette/unknown-field rules,
    // before any backup or writable copy is created.
    for(const region of regions(plan)){
      const expected=[];
      for(const{x,z}of region.chunks){
        progress(options,{phase:'Validating placement',x,z});
        const reader=createChunkReader(destination.root,settings.dimension),old=reader.read(x,z);requireThat(old,'PLACEMENT_UNKNOWN','Lighting chunk disappeared.');
        const updated=rewriteTemplateChunk(old.raw,x,z,patchesFor(plan,region.directory,x,z),{...options,airMode:settings.airMode});reader.verifyStable();
        expected.push({x,z,sha256:sha(updated.raw),changedBlocks:updated.changedBlocks});
      }
      writePlanFile(plan,path.join(region.directory,'expected.json'),JSON.stringify(expected));
    }
    verifyJournal(destination,plan,options);
    requireThat(absoluteStamp(file)===archiveStamp&&readWorldConfiguration(destination.root).digest===configuration.digest,'PLACEMENT_STALE','Template or destination configuration changed during review.');
    // No progress hooks after this silent observation sweep.
    verifyJournal(destination,plan,options);
    const warnings=[...settings.warnings,...configurationWarnings(header,configuration)];
    if(fluidFaces)warnings.push('Known fluids touch selected cells; containment and joins need review.');
    if(counts.skippedAir)warnings.push(`${counts.skippedAir} captured air cells are skipped; destination blocks stay unchanged.`);
    if(counts.carved)warnings.push(`${counts.carved} destination blocks become captured air.`);
    const review={schemaVersion:2,executable:false,mode:'sparse-template-translation',copyEligible:true,blockers:[],warnings,reviewDigest:hash.digest('hex'),archiveDigest:ending.digest,archiveSummary:ending.summary,airMode:settings.airMode,anchor:{...anchor},source:{header},destination:{bounds:settings.bounds},counts:serialCounters(counts),effects:{changedBlocks:(selected-counts.unchanged-counts.skippedAir).toString(),skippedAir:counts.skippedAir.toString(),sourceAir:serialCounters(sourceAir)},lightingChunks:lightingChunks.toString(),boundary:{fluidFaces:fluidFaces.toString(),unknownFaces:'0'}};
    return Object.assign(plan,{review,archiveStamp,header});
  }catch(error){fs.rmSync(plan.directory,{recursive:true,force:true});throw error;}
}
function blocked(error,options) {if(error.code==='TEMPLATE_CANCELLED'||error.name==='AbortError')throw error;return{schemaVersion:2,executable:false,copyEligible:false,blockers:[error.message],warnings:[],reviewDigest:null,airMode:options.airMode??'include'};}

/** Read-only bounded preview. Sparse masks never become their enclosing volume. */
export function previewTemplatePlacement(file,destination,dimensionKey,anchor,options={}) {
  const parent=externalParent(os.tmpdir(),[destination.root,...(options.worlds??[])]);let plan;
  try {plan=preparePlan(file,destination,dimensionKey,anchor,options,parent);return plan.review;}
  catch(error){return blocked(error,options);}finally{if(plan)fs.rmSync(plan.directory,{recursive:true,force:true});}
}
function hashBatched(file,options) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),buffer=Buffer.alloc(1024*1024),hash=createHash('sha256');
  try{for(;;){cancel(options);const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n));}return hash.digest('hex');}finally{fs.closeSync(fd);}
}
function expectedRegion(plan,relative) {
  const folder=path.join(plan.dimension.path==='.'?'':plan.dimension.path,'region'),name=path.basename(relative),match=/^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
  if(path.dirname(relative)!==folder||!match)return null;
  const file=path.join(plan.regions,coordKey(Number(match[1]),Number(match[2])),'output.sha256');
  return fs.existsSync(path.dirname(file))?readPlanFile(plan,file,64).toString():null;
}
function verifyFiles(root,manifest,plan,options) {
  const before=inventory(root),paths=before.files.map(f=>f.path).sort();requireThat(JSON.stringify(paths)===JSON.stringify(manifest.files.map(f=>f.path).sort())&&JSON.stringify(before.directories.slice().sort())===JSON.stringify(manifest.directories.slice().sort()),'PLACEMENT_FILES','World file inventory changed unexpectedly.');
  for(const file of manifest.files){cancel(options);const expected=plan?expectedRegion(plan,file.path):null;requireThat(hashBatched(safePath(root,file.path),options)===(expected??file.sha256),'PLACEMENT_FILES',`Unexpected world file change: ${file.path}`);}
  requireThat(JSON.stringify(inventory(root))===JSON.stringify(before),'PLACEMENT_FILES','World files changed during final verification.');return before;
}
function validWorld(world) {requireThat(!world.totals.invalidChunks&&!(world.validationErrors?.length)&&world.dimensions.every(d=>!d.issues.length&&d.regions.every(r=>!r.issues.length)),'PLACEMENT_VERIFY','Placed world failed structural validation.');}

/** Writes only a fresh owned working copy; original worlds never become output roots. */
export function createTemplatePlacedCopy(file,destination,dimensionKey,anchor,parent,options={}) {
  const{confirmedClosed=false,reviewDigest}=options;
  requireThat(confirmedClosed===true,'WORLD_OPEN','Close Minecraft and all servers before making the test copy.');cancel(options);
  const initial=previewTemplatePlacement(file,destination,dimensionKey,anchor,options);
  requireThat(initial.copyEligible,'PLACEMENT_BLOCKED',initial.blockers.join(' '));requireThat(initial.reviewDigest===reviewDigest,'PLACEMENT_STALE','The template or destination changed. Review a fresh placement before copying.');
  const output=externalParent(parent,[destination.root,...(options.worlds??[])]),id=randomUUID(),stage=path.join(output,`.WorldRenew-placement-${id}.partial`),final=path.join(output,`WorldRenew-placement-${id}`);
  fs.mkdirSync(stage,{mode:0o700});let backup,working,plan,manifestDigest;
  const journal=status=>fs.writeFileSync(path.join(stage,'operation.json'),JSON.stringify({schema:2,status,archiveDigest:initial.archiveDigest,reviewDigest,anchor,airMode:initial.airMode,dimension:dimensionKey},null,2),{mode:0o600});
  const reportProgress=value=>progress(options,value);
  const label=(copy,name)=>{const directory=path.join(stage,name);fs.renameSync(copy.directory,directory);return{...copy,directory,world:path.join(directory,'world'),manifest:path.join(directory,'manifest.json')};};
  try{
    journal('backing-up');backup=createVerifiedCopy(destination.root,stage,{confirmedClosed:true},reportProgress);backup=label(backup,'backup');manifestDigest=sha(readBounded(backup.directory,'manifest.json',128*1024*1024));cancel(options);
    journal('creating-working-copy');working=createVerifiedCopy(backup.world,stage,{confirmedClosed:true},reportProgress);working=label(working,'result');cancel(options);
    const copied=inspectWorld(working.world);plan=preparePlan(file,copied,dimensionKey,anchor,options,stage);
    requireThat(plan.review.copyEligible&&plan.review.reviewDigest===reviewDigest,'PLACEMENT_STALE','Copied inputs differ from the reviewed placement.');
    journal('placing');let modifiedCount=0,preparedChunks=0n;const modifiedRegions=[];
    for(const region of regions(plan)){
      progress(options,{phase:'Placing template region',x:region.regionX,z:region.regionZ,completed:modifiedCount});
      const expected=JSON.parse(readPlanFile(plan,path.join(region.directory,'expected.json'),256*1024)),byKey=new Map(expected.map(e=>[coordKey(e.x,e.z),e]));
      const prepared=path.join(plan.directory,`prepared-${coordKey(region.regionX,region.regionZ)}.mca`);
      prepareTemplateRegion(working.world,plan.dimension,region.regionX,region.regionZ,prepared,new Set(region.chunks.map(c=>c.slot)),({x,z,raw})=>{
        const changed=rewriteTemplateChunk(raw,x,z,patchesFor(plan,region.directory,x,z),{...options,airMode:initial.airMode});requireThat(sha(changed.raw)===byKey.get(coordKey(x,z))?.sha256,'PLACEMENT_VERIFY','Prepared chunk differs from reviewed sparse placement.');return changed.raw;
      },options);
      const preparedStamp=absoluteStamp(prepared),digest=hashBatched(prepared,options),relative=relativeRegion(plan.dimension,region.regionX*32,region.regionZ*32);
      writePlanFile(plan,path.join(region.directory,'output.sha256'),digest);cancel(options);requireThat(absoluteStamp(prepared)===preparedStamp,'PLACEMENT_STALE','Prepared region changed before installation.');fs.renameSync(prepared,safePath(working.world,relative));
      for(const wanted of expected){cancel(options);const reader=createChunkReader(working.world,plan.dimension),actual=reader.read(wanted.x,wanted.z);requireThat(actual&&sha(actual.raw)===wanted.sha256,'PLACEMENT_VERIFY','Written chunk differs from its verified rewrite.');reader.verifyStable();}
      modifiedCount++;preparedChunks+=BigInt(expected.length);if(modifiedRegions.length<20)modifiedRegions.push(relative);
    }
    requireThat(preparedChunks===BigInt(plan.review.lightingChunks),'PLACEMENT_PLAN','Placement did not prepare every reviewed chunk.');
    verifyContributions(plan,BigInt(plan.review.lightingChunks));
    journal('validating');progress(options,{phase:'Verifying placed files',file:working.world});validWorld(inspectWorld(working.world));
    const manifestRaw=readBounded(backup.directory,'manifest.json',128*1024*1024);requireThat(sha(manifestRaw)===manifestDigest,'PLACEMENT_STALE','Verified backup manifest changed.');const manifest=JSON.parse(manifestRaw);
    const workingInventory=verifyFiles(working.world,manifest,plan,options),backupInventory=verifyFiles(backup.world,manifest,null,options),sourceInventory=verifyFiles(destination.root,manifest,null,options);
    requireThat(absoluteStamp(file)===plan.archiveStamp,'PLACEMENT_STALE','Template changed before copy publication.');
    const report={schema:2,status:'validated-test-copy',gameLoadTested:false,blocks:initial.archiveSummary.selectedBlocks,airMode:initial.airMode,effects:initial.effects,counts:initial.counts,modifiedRegions,modifiedRegionCount:modifiedCount,modifiedRegionsTruncated:modifiedCount>modifiedRegions.length,lightingChunks:initial.lightingChunks,archiveDigest:initial.archiveDigest,warnings:initial.warnings};
    fs.writeFileSync(path.join(stage,'validation.json'),JSON.stringify(report,null,2),{mode:0o600});journal('validated-test-copy');cancel(options);
    // No user callbacks after these final identity checks and before publication.
    verifyContributions(plan,BigInt(plan.review.lightingChunks));
    for(const region of regions(plan))readPlanFile(plan,path.join(region.directory,'output.sha256'),64);
    for(const[root,expected]of[[working.world,workingInventory],[backup.world,backupInventory],[destination.root,sourceInventory]])requireThat(JSON.stringify(inventory(root))===JSON.stringify(expected),'PLACEMENT_FILES','World changed before copy publication.');
    requireThat(absoluteStamp(file)===plan.archiveStamp,'PLACEMENT_STALE','Template changed before copy publication.');
    fs.rmSync(plan.directory,{recursive:true,force:true});plan=null;
    const backupRelative=path.relative(stage,backup.world),worldRelative=path.relative(stage,working.world);fs.renameSync(stage,final);
    return{directory:final,world:path.join(final,worldRelative),backup:path.join(final,backupRelative),report:path.join(final,'validation.json'),blocks:report.blocks,airMode:report.airMode,effects:report.effects};
  }catch(error){
    if(plan)fs.rmSync(plan.directory,{recursive:true,force:true});if(working)fs.rmSync(working.directory,{recursive:true,force:true});
    if(backup){journal('failed-working-copy-discarded');error.message+=` Verified backup retained at ${backup.world}`;}else fs.rmSync(stage,{recursive:true,force:true});throw error;
  }
}
