import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SparseSelection,validateSelectionBounds} from './sparse-selection.js';
import {projectDirectoryOutsideWorld} from './projects.js';
import {safePath,readBounded} from './paths.js';
import {requireThat} from './errors.js';
import {createChunkReader,decodeSection} from './chunks.js';
import {terrainHeights,terrainSupport} from './terrain-policy.js';
import {terrainColor} from './terrain-colors.js';
import {captureTemplateStream} from './template-capture.js';
import {importTemplateStream} from './template-stream-library.js';
import {templateFilename} from './template-library.js';
import {checkTemplateCancellation} from './template-stream.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_DRAFT=65*1024*1024;
function dimensionOf(world,key){const d=world?.dimensions?.find(d=>d.key===key);requireThat(d,'TEMPLATE_DIMENSION','Choose an inspected source dimension.');return d;}
function location(directory,world,key){
  projectDirectoryOutsideWorld(directory,world);const root=path.resolve(directory),file=hash(JSON.stringify([world.root,key]))+'.json';
  return {root,file};
}
function selectionBounds(world,dimension,input){
  const bounds=validateSelectionBounds(input),height=terrainHeights[dimension.id];
  requireThat(height,'TEMPLATE_DIMENSION','Custom dimension heights are unsupported.');
  requireThat(bounds.minY>=height.minY&&bounds.maxY<=height.maxY,'TEMPLATE_HEIGHT',`Choose Y from ${height.minY} to ${height.maxY}.`);return bounds;
}
function readDraft(directory,world,key){
  const dimension=dimensionOf(world,key),{root,file}=location(directory,world,key);let data,revision='empty';
  try{const bytes=readBounded(root,file,MAX_DRAFT);revision=hash(bytes);data=JSON.parse(bytes);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(data)requireThat(data.schema===1&&data.worldRoot===world.root&&data.dimension===key,'TEMPLATE_DRAFT','Selection belongs to a different world or dimension.');
  const selection=data?SparseSelection.fromJSON(data.selection):new SparseSelection();
  if(selection.bounds)selectionBounds(world,dimension,selection.bounds);
  return {selection,revision,dimension,metadataChanged:Boolean(data&&data.fingerprint!==world.fingerprint)};
}
export function templateWorkspace(directory,world,key){const {selection,revision,dimension,metadataChanged}=readDraft(directory,world,key);return {revision,dimension:key,dimensionId:dimension.id,bounds:selection.bounds,selectedBlocks:selection.blockCount.toString(),boxes:selection.boxCount,height:terrainHeights[dimension.id]??null,metadataChanged};}
export function editTemplateSelection(directory,world,key,{operation,bounds,revision}){
  let draft=readDraft(directory,world,key);requireThat(draft.revision===revision,'TEMPLATE_DRAFT_STALE','Selection changed. Reload it before applying this edit.');
  requireThat(['replace','add','remove','clear'].includes(operation),'TEMPLATE_EDIT','Choose Replace, Add, Remove or Clear.');
  const box=operation==='clear'?null:selectionBounds(world,draft.dimension,bounds);
  if(operation==='replace'||operation==='clear')draft.selection=new SparseSelection();
  if(operation==='replace'||operation==='add')draft.selection.addBox(box);if(operation==='remove')draft.selection.removeBox(box);
  const {root,file}=location(directory,world,key);fs.mkdirSync(root,{recursive:true});
  // Recheck the final directory after creation; no draft may be stored in a save.
  projectDirectoryOutsideWorld(root,world);
  const bytes=Buffer.from(JSON.stringify({schema:1,worldRoot:world.root,dimension:key,fingerprint:world.fingerprint,selection:draft.selection.toJSON()}));requireThat(bytes.length<=MAX_DRAFT,'TEMPLATE_DRAFT_LIMIT','Selection edits exceed the draft metadata budget.');
  const temporary=path.join(root,`.selection-${randomUUID()}.tmp`);
  try{fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});fs.renameSync(temporary,path.join(root,file));}finally{try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return templateWorkspace(directory,world,key);
}
function validateSlice(world,key,request){
  const dimension=dimensionOf(world,key),height=terrainHeights[dimension.id];requireThat(height,'TEMPLATE_DIMENSION','Custom dimension heights are unsupported.');
  requireThat(Number.isInteger(request?.y)&&request.y>=height.minY&&request.y<=height.maxY,'TEMPLATE_HEIGHT','Choose a height inside this dimension.');
  requireThat(Array.isArray(request.chunks)&&request.chunks.length>0&&request.chunks.length<=16&&request.chunks.every(c=>Number.isInteger(c.x)&&Number.isInteger(c.z)&&Math.abs(c.x)<=1875000&&Math.abs(c.z)<=1875000),'TEMPLATE_SLICE_LIMIT','A height-slice request covers at most 16 valid chunks.');return dimension;
}
export function sourceTemplateSlice(directory,world,key,request,options={}){
  const dimension=validateSlice(world,key,request),reason=terrainSupport(world.metadata,dimension);requireThat(!reason,'TEMPLATE_UNSUPPORTED',reason);
  // Capture's supported source schema remains 26.2/26.3, independent of map adapters.
  requireThat(['26.2','26.3'].includes(world.metadata.version),'TEMPLATE_UNSUPPORTED','Template capture and height slices currently support stable Java 26.2 and 26.3 only.');
  const draft=readDraft(directory,world,key),boxes=draft.selection.toJSON().boxes,tiles=[],regionCache=new Map();
  const stable=()=>requireThat(hash(readBounded(world.root,'level.dat',16*1024*1024))===world.fingerprint,'WORLD_CHANGED','Source metadata changed. Refresh the world before editing this selection.');stable();
  for(const {x,z} of request.chunks){
    checkTemplateCancellation(options);const selected=new Uint8Array(256);
    for(const b of boxes){if(request.y<b.minY||request.y>b.maxY||b.maxX<x*16||b.minX>x*16+15||b.maxZ<z*16||b.minZ>z*16+15)continue;
      for(let bz=Math.max(z*16,b.minZ);bz<=Math.min(z*16+15,b.maxZ);bz++)for(let bx=Math.max(x*16,b.minX);bx<=Math.min(x*16+15,b.maxX);bx++)selected[(bz-z*16)*16+bx-x*16]=1;}
    let tile={x,z,y:request.y,selected};
    try{
      const reader=createChunkReader(world.root,dimension,{regionCache}),chunk=reader.read(x,z);
      for(const r of reader.regions.values())requireThat(!r?.issues.length,'CHUNK_ALLOCATION','Unreadable region: absence is unverified.');
      if(!chunk)tile.status='absent';
      else{
        requireThat(chunk.nbt.DataVersion===world.metadata.dataVersion,'TEMPLATE_UNSUPPORTED','Chunk version differs from the template capture adapter.');
        const sy=Math.floor(request.y/16),matches=chunk.nbt.sections.filter(s=>s.Y===sy);
        requireThat(matches.length===1&&matches[0].block_states,'TEMPLATE_UNKNOWN','This slice has a missing or duplicate block section. Unknown is not air.');
        const decoded=decodeSection(matches[0]),ids=new Uint16Array(256),rgba=new Uint8ClampedArray(1024),offset=((request.y%16+16)%16)*256;
        for(let i=0;i<256;i++){ids[i]=decoded.indices[offset+i];const rgb=terrainColor(decoded.palette[ids[i]].Name).rgb;rgba.set([(rgb>>16)&255,(rgb>>8)&255,rgb&255,255],i*4);}
        Object.assign(tile,{status:'ready',ids,rgba,palette:decoded.palette});
      }
      reader.verifyStable();
    }catch(error){tile={...tile,status:error.code==='TEMPLATE_UNSUPPORTED'?'unsupported':'unreadable',code:error.code??'IO_ERROR',message:error.message};}
    tiles.push(tile);
  }
  stable();return {tiles,revision:draft.revision,y:request.y};
}
export function captureWorkspaceTemplate(directory,library,world,key,{name,revision},options={}){
  const draft=readDraft(directory,world,key);requireThat(draft.revision===revision,'TEMPLATE_DRAFT_STALE','Selection changed. Review the current selection before saving.');
  requireThat(draft.selection.blockCount>0n,'TEMPLATE_EMPTY','Select at least one block.');
  requireThat(typeof name==='string'&&name.trim().length>0&&name.length<=100,'TEMPLATE_NAME','Enter a template name, up to 100 characters.');
  for(const root of options.worlds??[])projectDirectoryOutsideWorld(library,{root});projectDirectoryOutsideWorld(library,world);fs.mkdirSync(library,{recursive:true});
  const temporary=path.join(library,`.capture-${randomUUID()}.wrbuild`);
  try{
    captureTemplateStream(temporary,world,key,draft.selection,{...options,worlds:[...(options.worlds??[]),world.root]});
    // Import uses the requested portable filename but still chooses a unique library name.
    const namedDirectory=path.join(library,`.capture-name-${randomUUID()}`);fs.mkdirSync(namedDirectory);
    try{
      const named=path.join(namedDirectory,templateFilename(name));fs.renameSync(temporary,named);
      return importTemplateStream(library,named,{...options,worlds:[...(options.worlds??[]),world.root]});
    }finally{fs.rmSync(namedDirectory,{recursive:true,force:true});}
  }finally{try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
