import fs from 'node:fs';
import { readWorldConfiguration, validateConfigurationProvenance } from './world-configuration.js';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {captureVolume,validateBounds,indexOf} from './volumes.js';
import {createChunkReader,decodeSection,stateKey,isAir,isFluid} from './chunks.js';
import {parseNBT} from './nbt.js';
import {canonicalWorld,isWithin,readBounded} from './paths.js';
import {requireThat} from './errors.js';
const MAGIC=Buffer.from('WRBUILD1\n'),MAX_FILE=64*1024*1024,MAX_JSON=192*1024*1024;
export const sha=b=>createHash('sha256').update(b).digest('hex');
export function externalParent(parent,worlds=[]){
  const root=canonicalWorld(parent);
  for(const world of worlds)requireThat(!isWithin(canonicalWorld(world),root),'ARCHIVE_IN_WORLD','Choose a location outside every open Minecraft save.');
  for(let p=root;;p=path.dirname(p)){requireThat(!fs.existsSync(path.join(p,'level.dat')),'ARCHIVE_IN_WORLD','Build files and copies cannot be stored inside a Minecraft save.');if(path.dirname(p)===p)break;}
  return root;
}
const inside=(p,b)=>p&&['x','y','z'].every(k=>Number.isFinite(p[k])&&p[k]>=b['min'+k.toUpperCase()]&&p[k]<b['max'+k.toUpperCase()]+1);
export function validEntity(e){return e&&typeof e.id==='string'&&Array.isArray(e.Pos)&&e.Pos.length===3&&e.Pos.every(Number.isFinite)&&(e.Passengers===undefined||Array.isArray(e.Passengers)&&e.Passengers.every(validEntity));}
export function entityInside(e,b){
  if(inside({x:e.TileX,y:e.TileY,z:e.TileZ},b))return true;
  return Array.isArray(e.Pos)&&inside({x:e.Pos[0],y:e.Pos[1],z:e.Pos[2]},b)||Array.isArray(e.Passengers)&&e.Passengers.some(p=>entityInside(p,b));
}
export function captureBuildArchive(world,dimensionKey,bounds,progress=()=>{},expectedDigest){
  const configuration=readWorldConfiguration(world.root,{fingerprintPacks:false});
  const volume=captureVolume(world,dimensionKey,bounds,progress);requireThat(volume.complete,'ARCHIVE_INCOMPLETE','A portable build needs a complete block selection. Unknown chunks cannot be saved as air.');
  if(expectedDigest)requireThat(volume.digest===expectedDigest,'ARCHIVE_CHANGED','Source blocks changed since the displayed scan. Reload the selection before saving.');
  const dimension=world.dimensions.find(d=>d.key===dimensionKey),reader=createChunkReader(world.root,dimension),records=[];
  for(let z=Math.floor(bounds.minZ/16);z<=Math.floor(bounds.maxZ/16);z++)for(let x=Math.floor(bounds.minX/16);x<=Math.floor(bounds.maxX/16);x++)for(const store of ['region','entities','poi']){
    progress({phase:'Capturing portable build',file:`${store} ${x}, ${z}`});
    const c=reader.read(x,z,store),old=volume.snapshots.find(s=>s.store===store&&s.x===x&&s.z===z);
    if(store==='region')requireThat(c&&old?.sha256===reader.snapshots.get(`${store}:${x},${z}`)?.sha256,'ARCHIVE_CHANGED','Source changed between block and attachment capture.');
    records.push({store,x,z,nbt:c?c.raw.toString('base64'):null,sha256:c?sha(c.raw):null});
  }
  reader.verifyStable();requireThat(sha(readBounded(world.root,'level.dat',16*1024*1024))===world.fingerprint,'ARCHIVE_CHANGED','World metadata changed during capture.');
  requireThat(readWorldConfiguration(world.root,{fingerprintPacks:false}).digest===configuration.digest,'ARCHIVE_CHANGED','World metadata, feature flags, datapack configuration or generation settings changed during capture.');
  const archive={format:'WorldRenew.build',schema:1,createdAt:new Date().toISOString(),source:{name:world.metadata.name,version:volume.version,dataVersion:volume.dataVersion,dimensionId:dimension.id,dimensionKey,bounds:volume.bounds,configuration:configuration.provenance},records};
  const checked=validateBuildArchive(archive);requireThat(checked.volume.voxels.every((id,i)=>stateKey(checked.volume.palette[id])===stateKey(volume.palette[volume.voxels[i]])),'ARCHIVE_CHANGED','Archived blocks differ from the selected scan.');return archive;
}
export function validateBuildArchive(archive){
  requireThat(archive?.format==='WorldRenew.build'&&archive.schema===1,'ARCHIVE_FORMAT','Unsupported portable build format.');
  const s=archive.source;requireThat(s&&typeof s.name==='string'&&s.name.length<=1024&&/^26\.[23](?:\.\d+)?$/.test(s.version)&&Number.isInteger(s.dataVersion)&&typeof s.dimensionId==='string'&&/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(s.dimensionId)&&typeof s.dimensionKey==='string','ARCHIVE_SOURCE','Invalid build provenance or unsupported version.');
  if(s.configuration!==undefined)validateConfigurationProvenance(s.configuration);
  const {bounds,size,count}=validateBounds(s.bounds),expected=new Set();
  for(let z=Math.floor(bounds.minZ/16);z<=Math.floor(bounds.maxZ/16);z++)for(let x=Math.floor(bounds.minX/16);x<=Math.floor(bounds.maxX/16);x++)for(const store of ['region','entities','poi'])expected.add(`${store}:${x},${z}`);
  requireThat(Array.isArray(archive.records)&&archive.records.length===expected.size,'ARCHIVE_RECORDS','Archive is missing chunk-store records.');
  const decoded=new Map();let bytes=0,entities=0;
  for(const r of archive.records){
    const key=`${r.store}:${r.x},${r.z}`;requireThat(Number.isInteger(r.x)&&Number.isInteger(r.z)&&expected.delete(key),'ARCHIVE_RECORDS','Duplicate or unexpected chunk record.');
    if(r.nbt===null){requireThat(r.store!=='region'&&r.sha256===null,'ARCHIVE_MISSING','Terrain record is missing.');decoded.set(key,null);continue;}
    requireThat(typeof r.nbt==='string'&&r.nbt.length<=Math.ceil(32*1024*1024/3)*4&&r.nbt.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(r.nbt),'ARCHIVE_RECORD','Invalid encoded chunk data.');
    const raw=Buffer.from(r.nbt,'base64');bytes+=raw.length;requireThat(bytes<=128*1024*1024&&sha(raw)===r.sha256,'ARCHIVE_CHECKSUM','Archive chunk checksum or byte budget failed.');
    const nbt=parseNBT(raw);requireThat(nbt.DataVersion===undefined&&r.store==='poi'||nbt.DataVersion===s.dataVersion,'ARCHIVE_VERSION','Archive chunks use inconsistent DataVersions.');
    if(r.store==='region')requireThat(nbt.xPos===r.x&&nbt.zPos===r.z&&['full','minecraft:full'].includes(nbt.Status)&&Array.isArray(nbt.sections),'ARCHIVE_CHUNK','Invalid terrain chunk in archive.');
    if(r.store==='entities'){
      requireThat(Array.isArray(nbt.Entities)&&nbt.Entities.every(validEntity)&&Array.isArray(nbt.Position)&&nbt.Position.length===2&&nbt.Position[0]===r.x&&nbt.Position[1]===r.z,'ARCHIVE_ENTITIES','Invalid entity chunk position or entity list.');
      entities+=nbt.Entities.filter(e=>entityInside(e,bounds)).length;
    }
    decoded.set(key,{nbt,raw});
  }
  const palette=[null],ids=new Map(),voxels=new Uint32Array(count),sections=new Map(),attachments={blockEntities:[],blockTicks:[],fluidTicks:[],entityCount:entities,biomesTransferred:false};
  for(const [key,c] of decoded)if(key.startsWith('region:')){
    requireThat(new Set(c.nbt.sections.map(s=>s.Y)).size===c.nbt.sections.length,'ARCHIVE_SECTION','Duplicate section Y.');
    for(const section of c.nbt.sections){requireThat(Number.isInteger(section.Y)&&!sections.has(`${key}:${section.Y}`),'ARCHIVE_SECTION','Duplicate or invalid section Y.');if(section.block_states)sections.set(`${key}:${section.Y}`,decodeSection(section));}
    for(const[field,out]of [['block_entities','blockEntities'],['block_ticks','blockTicks'],['fluid_ticks','fluidTicks']]){requireThat(Array.isArray(c.nbt[field])&&c.nbt[field].every(p=>['x','y','z'].every(k=>Number.isInteger(p?.[k]))),'ARCHIVE_METADATA',`Missing ${field} data.`);attachments[out].push(...c.nbt[field].filter(p=>inside(p,bounds)));}
  }
  const touched={minX:0,maxX:0,minY:0,maxY:0,minZ:0,maxZ:0};let air=0,nonAir=0,fluids=0;
  for(let y=0;y<size.y;y++)for(let z=0;z<size.z;z++)for(let x=0;x<size.x;x++){
    const wx=x+bounds.minX,wy=y+bounds.minY,wz=z+bounds.minZ,section=sections.get(`region:${Math.floor(wx/16)},${Math.floor(wz/16)}:${Math.floor(wy/16)}`);
    requireThat(section,'ARCHIVE_UNKNOWN','Selection contains an absent block section.');
    const state=section.palette[section.indices[((wy%16+16)%16)*256+((wz%16+16)%16)*16+(wx%16+16)%16]],key=stateKey(state);let id=ids.get(key);
    if(id===undefined){requireThat(palette.length<=65536,'ARCHIVE_PALETTE','Too many distinct states.');id=palette.length;ids.set(key,id);palette.push(state);}voxels[indexOf(size,x,y,z)]=id;
    if(isAir(state))air++;else{nonAir++;if(isFluid(state))fluids++;if(x===0)touched.minX++;if(x===size.x-1)touched.maxX++;if(y===0)touched.minY++;if(y===size.y-1)touched.maxY++;if(z===0)touched.minZ++;if(z===size.z-1)touched.maxZ++;}
  }
  const volume={schemaVersion:1,root:'Portable build',dimension:s.dimensionKey,version:s.version,dataVersion:s.dataVersion,bounds,size,palette,voxels,digest:sha(Buffer.concat([Buffer.from(JSON.stringify({bounds,palette})),Buffer.from(voxels.buffer)])),capturedAt:archive.createdAt,stats:{total:count,nonAir,air,fluids,unknown:0,paletteStates:palette.length-1},boundaryNonAir:touched,complete:true,issues:[],missingChunks:[],attachments,snapshots:[]};
  return {volume,decoded,summary:{name:s.name,dimension:s.dimensionId,blocks:count,entities,blockEntities:attachments.blockEntities.length,ticks:attachments.blockTicks.length+attachments.fluidTicks.length,rawBytes:bytes,coverage:'Exact selected blocks and air; full supporting terrain/entity/POI chunk records, including surrounding content. Entity selection uses positions/passengers, not geometric intersection. Biomes and typed metadata preserved in supporting records.'}};
}
export function encodeBuild(archive){
  validateBuildArchive(archive);const json=Buffer.from(JSON.stringify(archive));requireThat(json.length<=MAX_JSON,'ARCHIVE_SIZE','Build archive exceeds the expanded limit.');const bytes=Buffer.concat([MAGIC,Buffer.from(sha(json),'hex'),gzipSync(json)]);requireThat(bytes.length<=MAX_FILE,'ARCHIVE_SIZE','Build archive exceeds 64 MiB.');return bytes;
}
export function decodeBuildBytes(bytes){
  requireThat(Buffer.isBuffer(bytes)&&bytes.length<=MAX_FILE,'ARCHIVE_SIZE','Build archive exceeds 64 MiB.');
  requireThat(bytes.subarray(0,MAGIC.length).equals(MAGIC),'ARCHIVE_FORMAT','This is not a WorldRenew build file.');
  let json;try{json=gunzipSync(bytes.subarray(MAGIC.length+32),{maxOutputLength:MAX_JSON});}catch{throw Error('Damaged or oversized build archive.');}
  requireThat(sha(json)===bytes.subarray(MAGIC.length,MAGIC.length+32).toString('hex'),'ARCHIVE_CHECKSUM','Build archive checksum failed.');const archive=JSON.parse(json.toString('utf8'));
  return {archive,...validateBuildArchive(archive),digest:sha(bytes)};
}
export function readBuildFile(file){
  return decodeBuildBytes(readBounded(path.dirname(path.resolve(file)),path.basename(file),MAX_FILE));
}
export function saveBuildFile(file,archive,worlds=[]){
  const parent=externalParent(path.dirname(path.resolve(file)),worlds),target=path.join(parent,path.basename(file));requireThat(!fs.existsSync(target),'ARCHIVE_EXISTS','Choose a new filename; existing build files are not overwritten.');
  const bytes=encodeBuild(archive),temporary=path.join(parent,`.worldrenew-${randomUUID()}.partial`);
  try{fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});const checked=readBuildFile(temporary);requireThat(checked.digest===sha(bytes),'ARCHIVE_VERIFY','Saved archive verification failed.');fs.linkSync(temporary,target);return {file:target,digest:checked.digest,summary:checked.summary,volume:checked.volume};}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
