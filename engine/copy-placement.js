import { readWorldConfiguration } from './world-configuration.js';
import registeredBlocks from './placement-blocks.json' with {type:'json'};
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readBuildFile,externalParent,sha,entityInside,validEntity} from './build-archive.js';
import {previewCapturedTransfer,DIFFERENCE} from './transfers.js';
import {captureVolume,indexOf} from './volumes.js';
import {createChunkReader,decodeSection,stateKey,isAir} from './chunks.js';
import {readTypedNBT,writeTypedNBT,tag,compound,field,setField,removeField,plain} from './typed-nbt.js';
import {replaceRegionRecords} from './region-writer.js';
import {createVerifiedCopy,hashFile} from './safety.js';
import {inspectWorld} from './world.js';
import {readBounded,safePath} from './paths.js';
import {requireThat} from './errors.js';
const REGISTERED=new Set(registeredBlocks);
const BASIC=new Set('air cave_air void_air stone granite diorite andesite polished_granite polished_diorite polished_andesite dirt coarse_dirt grass_block cobblestone mossy_cobblestone stone_bricks cracked_stone_bricks mossy_stone_bricks chiseled_stone_bricks bricks glass obsidian netherrack nether_bricks red_nether_bricks end_stone end_stone_bricks quartz_block smooth_quartz sandstone smooth_sandstone cut_sandstone chiseled_sandstone red_sandstone smooth_red_sandstone cut_red_sandstone chiseled_red_sandstone deepslate cobbled_deepslate polished_deepslate deepslate_bricks deepslate_tiles blackstone polished_blackstone polished_blackstone_bricks terracotta tuff calcite packed_mud mud_bricks snow_block iron_block gold_block diamond_block emerald_block lapis_block coal_block netherite_block amethyst_block'.split(' '));
const WOODS='oak spruce birch jungle acacia dark_oak mangrove cherry pale_oak bamboo crimson warped'.split(' '),COLORS='white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(' ');
const SHAPES=new Set('stone cobblestone mossy_cobblestone stone_brick mossy_stone_brick brick sandstone smooth_sandstone cut_sandstone red_sandstone smooth_red_sandstone cut_red_sandstone nether_brick red_nether_brick end_stone_brick quartz smooth_quartz purpur prismarine prismarine_brick dark_prismarine granite polished_granite diorite polished_diorite andesite polished_andesite cobbled_deepslate polished_deepslate deepslate_brick deepslate_tile blackstone polished_blackstone polished_blackstone_brick mud_brick tuff polished_tuff tuff_brick'.split(' '));
export function placeableState(s){
  if(!REGISTERED.has(s?.Name))return false;const n=s.Name.slice(10),p=s.Properties??{};
  const props=allowed=>Object.entries(p).every(([k,v])=>allowed[k]?.includes(v));
  if(BASIC.has(n))return props(n==='grass_block'?{snowy:['true','false']}:{});
  if(COLORS.some(c=>['concrete','terracotta','wool','stained_glass'].some(v=>n===`${c}_${v}`)))return props({});
  if(WOODS.some(w=>n===w+'_planks'))return props({});
  if(WOODS.some(w=>['log','wood','stem','hyphae'].some(v=>n===`${w}_${v}`||n===`stripped_${w}_${v}`)))return props({axis:['x','y','z']});
  const material=n.replace(/_(stairs|slab)$/,'');if(!SHAPES.has(material)&&!WOODS.includes(material))return false;
  if(n.endsWith('_stairs'))return props({facing:['north','south','east','west'],half:['top','bottom'],shape:['straight','inner_left','inner_right','outer_left','outer_right'],waterlogged:['false']});
  if(n.endsWith('_slab'))return props({type:['top','bottom','double'],waterlogged:['false']});return false;
}
const within=(p,b)=>['x','y','z'].every(k=>Number.isInteger(p?.[k])&&p[k]>=b['min'+k.toUpperCase()]&&p[k]<=b['max'+k.toUpperCase()]);
function recordsInBounds(nbt,b){
  requireThat(nbt?.Sections&&typeof nbt.Sections==='object'&&!Array.isArray(nbt.Sections),'PLACEMENT_POI','Unsupported POI sections.');
  requireThat(Object.values(nbt.Sections).every(s=>s&&Array.isArray(s.Records)),'PLACEMENT_POI','Unsupported POI records.');
  for(const section of Object.values(nbt?.Sections??{}))for(const r of section.Records??[]){
    if(typeof r.pos!=='string')return true;const pos=BigInt(r.pos),p={x:Number(BigInt.asIntN(26,pos>>38n)),y:Number(BigInt.asIntN(12,pos)),z:Number(BigInt.asIntN(26,pos>>12n))};if(within(p,b))return true;
  }return false;
}
export function previewBuildFile(file,destination,dimensionKey,anchor,progress=()=>{},protection=[],options={}){
  const configuration=readWorldConfiguration(destination.root);
  const build=readBuildFile(file),p=previewCapturedTransfer(build.volume,build.archive.source.dimensionId,destination,dimensionKey,anchor,progress,options),blockers=p.blockers.slice(1),dimension=destination.dimensions.find(d=>d.key===dimensionKey);
  if(build.archive.source.version!=='26.2'||destination.metadata.version!=='26.2'||build.volume.dataVersion!==4903||destination.metadata.dataVersion!==4903)blockers.push('Copy placement currently supports the locally examined Java 26.2 / DataVersion 4903 format only. 26.3 build archives can be saved and previewed; placement needs its own validated adapter.');
  if(build.archive.source.dimensionId!==dimension?.id||!['minecraft:overworld','minecraft:the_nether','minecraft:the_end'].includes(dimension?.id))blockers.push('Copy placement requires the same vanilla dimension in both worlds.');
  if([...build.decoded.entries()].some(([key,c])=>key.startsWith('poi:')&&c&&recordsInBounds(c.nbt,build.volume.bounds)))blockers.push('Source points of interest need a future relocation adapter.');
  if(build.volume.attachments.blockEntities.length||build.volume.attachments.entityCount||build.volume.attachments.blockTicks.length||build.volume.attachments.fluidTicks.length)blockers.push('This build contains inventories/block entities, entities or scheduled updates. They are preserved in the archive, but their relocation is not supported yet.');
  const unsupported=[...new Set(build.volume.palette.filter(s=>s&&!placeableState(s)).map(s=>s.Name))];if(unsupported.length)blockers.push(`Source blocks need a future placement adapter: ${unsupported.slice(0,8).join(', ')}.`);
  if(p.destination.attachments.blockEntities.length||p.destination.attachments.blockTicks.length||p.destination.attachments.fluidTicks.length)blockers.push('Placement would touch destination block entities or scheduled updates.');
  if(p.source.voxels.some((id,i)=>p.differences[i]&&p.differences[i]!==DIFFERENCE.skippedAir&&!placeableState(p.destination.palette[p.destination.voxels[i]])))blockers.push('Placement would replace destination blocks that are not supported by the building-block adapter.');
  const reader=createChunkReader(destination.root,dimension),b=p.destination.bounds,ring=[];
  if(protection.some(c=>c.dimension===dimensionKey&&c.x>=Math.floor(b.minX/16)-1&&c.x<=Math.floor(b.maxX/16)+1&&c.z>=Math.floor(b.minZ/16)-1&&c.z<=Math.floor(b.maxZ/16)+1))blockers.push('Placement or its lighting border overlaps protected destination chunks. Choose a different location or explicitly revise the destination protection plan.');
  try{
    for(let z=Math.floor(b.minZ/16)-1;z<=Math.floor(b.maxZ/16)+1;z++)for(let x=Math.floor(b.minX/16)-1;x<=Math.floor(b.maxX/16)+1;x++){
      const c=reader.read(x,z);requireThat(c&&c.nbt.DataVersion===4903,'PLACEMENT_NEIGHBORS','Placement requires complete, matching-version chunks in the surrounding one-chunk lighting border.');
      requireThat(new Set(c.nbt.sections.map(s=>s.Y)).size===c.nbt.sections.length&&c.nbt.sections.every(s=>Number.isInteger(s.Y)),'PLACEMENT_SECTIONS','Duplicate or invalid destination sections.');
      for(const field of ['block_entities','block_ticks','fluid_ticks'])requireThat(Array.isArray(c.nbt[field])&&c.nbt[field].every(p=>['x','y','z'].every(k=>Number.isInteger(p?.[k]))),'PLACEMENT_METADATA','Destination attachments have missing coordinates.');
      requireThat(!c.nbt.below_zero_retrogen&&!c.nbt.UpgradeData&&!c.nbt.blending_data,'PLACEMENT_UPGRADE','Chunks with pending upgrade or terrain blending data are not supported.');requireThat(!c.nbt.PostProcessing?.some(v=>v.length),'PLACEMENT_UPDATES','Chunks with pending post-processing updates are not supported.');ring.push({x,z});
      const e=reader.read(x,z,'entities');if(e){requireThat(Array.isArray(e.nbt.Entities)&&e.nbt.Entities.every(validEntity)&&Array.isArray(e.nbt.Position)&&e.nbt.Position.length===2&&e.nbt.Position[0]===x&&e.nbt.Position[1]===z,'PLACEMENT_ENTITIES','Destination entity data is malformed.');if(e.nbt.Entities.some(v=>entityInside(v,b)))blockers.push('Destination entities overlap the placement. Choose an unoccupied area.');}
      const poi=reader.read(x,z,'poi');if(poi&&recordsInBounds(poi.nbt,b))blockers.push('Destination points of interest overlap the placement.');
    }
    reader.verifyStable();
  }catch(e){blockers.push(e.message);}
  requireThat(readWorldConfiguration(destination.root).digest===configuration.digest,'PLACEMENT_STALE','World feature flags, generation settings or datapacks changed during review.');
  const configurationWarnings=[...configuration.summary.notices];
  if(!build.archive.source.configuration)configurationWarnings.push('This older template has no recorded feature/datapack provenance. Supported block adapters still apply; no configuration is inferred.');
  else {
    const sourceConfiguration=build.archive.source.configuration;
    if(JSON.stringify(sourceConfiguration.fields)!==JSON.stringify(configuration.provenance.fields)||sourceConfiguration.generationSha256!==configuration.provenance.generationSha256)configurationWarnings.push('Recorded source and destination feature/datapack or generation settings differ. Only supported block states are placed; destination configuration is retained unchanged.');
    if(sourceConfiguration.packFiles===null)configurationWarnings.push('The template records configuration, but does not bundle or fingerprint datapack payloads. Required packs must already exist in the destination; WorldRenew does not install them.');
    else if(JSON.stringify(sourceConfiguration.packFiles)!==JSON.stringify(configuration.provenance.packFiles))configurationWarnings.push('Recorded source and destination datapack payloads differ. No datapacks will be installed or replaced.');
  }
  const snapshot=[...reader.snapshots.values()],reviewDigest=sha(Buffer.from(JSON.stringify({build:build.digest,world:destination.fingerprint,dimension:dimensionKey,anchor,airMode:p.airMode,configuration:configuration.digest,blocks:p.destination.digest,snapshot,protection})));
  return {...p,blockers:[...new Set(blockers)],warnings:[...p.warnings,...configurationWarnings,'Experimental building-block copy only: destination biomes are retained; entities, inventories, portals, fluids, redstone, rotation and blending are not placed. Minecraft must rebuild lighting and heightmaps on first load. Game-load certification is still pending.'],copyEligible:blockers.length===0,reviewDigest,archiveDigest:build.digest,archiveSummary:build.summary,ring};
}
function paletteNBT(states){
  const palette=[],lookup=new Map(),ids=states.map(s=>{const key=stateKey(s);if(!lookup.has(key)){lookup.set(key,palette.length);palette.push(s);}return lookup.get(key);});
  const node=compound({palette:tag(9,palette.map(s=>compound({Name:tag(8,s.Name),...(s.Properties?{Properties:compound(Object.fromEntries(Object.entries(s.Properties).map(([k,v])=>[k,tag(8,v)])))}:{})})),10)});
  if(palette.length>1){const bits=Math.max(4,Math.ceil(Math.log2(palette.length))),per=Math.floor(64/bits),words=[];for(let start=0;start<4096;start+=per){let w=0n;for(let n=0;n<per&&start+n<4096;n++)w|=BigInt(ids[start+n])<<BigInt(n*bits);words.push(BigInt.asIntN(64,w).toString());}setField(node,'data',tag(12,words));}return node;
}
function stripDerived(root,blocks){
  removeField(root,'isLightOn');if(blocks)removeField(root,'Heightmaps');
  for(const s of field(root,'sections').value){removeField(s,'BlockLight');removeField(s,'SkyLight');if(blocks)removeField(s,'block_states');}
  return writeTypedNBT(root);
}
function changeChunk(raw,x,z,source,anchor,airMode){
  const root=readTypedNBT(raw),sections=field(root,'sections');requireThat(sections?.type===9&&sections.elementType===10,'PLACEMENT_SCHEMA','Unsupported typed section list.');
  let changed=false;
  for(const section of sections.value){
    const sy=plain(field(section,'Y'));if(sy*16>anchor.y+source.size.y-1||sy*16+15<anchor.y||x*16>anchor.x+source.size.x-1||x*16+15<anchor.x||z*16>anchor.z+source.size.z-1||z*16+15<anchor.z)continue;
    const decoded=decodeSection(plain(section)),states=Array.from(decoded.indices,i=>decoded.palette[i]);let sectionChanged=false;
    for(let ly=0;ly<16;ly++)for(let lz=0;lz<16;lz++)for(let lx=0;lx<16;lx++){
      const dx=x*16+lx-anchor.x,dy=sy*16+ly-anchor.y,dz=z*16+lz-anchor.z;
      if(dx>=0&&dy>=0&&dz>=0&&dx<source.size.x&&dy<source.size.y&&dz<source.size.z){
        const sourceState=source.palette[source.voxels[indexOf(source.size,dx,dy,dz)]],index=ly*256+lz*16+lx;
        if(airMode==='skip'&&isAir(sourceState))continue;
        if(stateKey(states[index])!==stateKey(sourceState)){states[index]=sourceState;sectionChanged=true;}
      }
    }
    if(sectionChanged){setField(section,'block_states',paletteNBT(states));changed=true;}
  }
  if(changed)removeField(root,'Heightmaps');setField(root,'isLightOn',tag(1,0));for(const s of sections.value){removeField(s,'BlockLight');removeField(s,'SkyLight');}
  return {raw:writeTypedNBT(root),changed};
}
function verifyUntouchedBlocks(before,after,x,z,b){
  for(const s of before.sections){if(!s.block_states)continue;const a=decodeSection(s),t=after.sections.find(v=>v.Y===s.Y);requireThat(t?.block_states,'PLACEMENT_VERIFY','Section disappeared.');const c=decodeSection(t);
    for(let i=0;i<4096;i++){const p={x:x*16+i%16,y:s.Y*16+Math.floor(i/256),z:z*16+Math.floor(i/16)%16};if(!within(p,b))requireThat(stateKey(a.palette[a.indices[i]])===stateKey(c.palette[c.indices[i]]),'PLACEMENT_VERIFY','A block outside the selection changed.');}
  }
}
function verifyFiles(root,manifest,allowed=new Set()){
  const actual=fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>path.relative(root,path.join(d.parentPath,d.name))).sort();requireThat(JSON.stringify(actual)===JSON.stringify(manifest.files.map(f=>f.path).sort()),'PLACEMENT_FILES','World file inventory changed unexpectedly.');
  for(const f of manifest.files)if(!allowed.has(f.path))requireThat(hashFile(safePath(root,f.path))===f.sha256,'PLACEMENT_FILES',`Unexpected file change: ${f.path}`);
}
/** The sole mutating placement route owns a fresh working copy. No arbitrary output root is accepted. */
export function createPlacedCopy(file,destination,dimensionKey,anchor,parent,{confirmedClosed=false,reviewDigest,protection=[],airMode='include'}={},progress=()=>{}){
  requireThat(confirmedClosed===true,'WORLD_OPEN','Close Minecraft and all servers before making the test copy.');
  const initial=previewBuildFile(file,destination,dimensionKey,anchor,progress,protection,{airMode});requireThat(initial.copyEligible,'PLACEMENT_BLOCKED',initial.blockers.join(' '));requireThat(reviewDigest===initial.reviewDigest,'PLACEMENT_STALE','The build or destination changed. Review a fresh placement before copying.');
  const output=externalParent(parent,[destination.root]),id=randomUUID(),stage=path.join(output,`.WorldRenew-placement-${id}.partial`),final=path.join(output,`WorldRenew-placement-${id}`);fs.mkdirSync(stage,{mode:0o700});let backup,working;
  const labelCopy=(copy,label)=>{const directory=path.join(stage,label);fs.renameSync(copy.directory,directory);copy.directory=directory;copy.world=path.join(directory,'world');copy.manifest=path.join(directory,'manifest.json');};
  const journal=status=>fs.writeFileSync(path.join(stage,'operation.json'),JSON.stringify({schema:1,status,archiveDigest:initial.archiveDigest,reviewDigest,anchor,airMode,dimension:dimensionKey},null,2));
  try{
    journal('backing-up');backup=createVerifiedCopy(destination.root,stage,{confirmedClosed:true},progress);labelCopy(backup,'backup');journal('creating-working-copy');working=createVerifiedCopy(backup.world,stage,{confirmedClosed:true},progress);labelCopy(working,'result');
    const copied=inspectWorld(working.world),plan=previewBuildFile(file,copied,dimensionKey,anchor,progress,protection,{airMode});requireThat(plan.copyEligible&&plan.reviewDigest===reviewDigest,'PLACEMENT_STALE','Copy inputs differ from the reviewed placement.');
    const dim=copied.dimensions.find(d=>d.key===dimensionKey),reader=createChunkReader(working.world,dim),regions=new Map(),regionOriginals=new Map(),expected=[];
    journal('placing');
    for(const {x,z}of plan.ring){const old=reader.read(x,z),updated=changeChunk(old.raw,x,z,plan.source,anchor,airMode),relative=path.join(dim.path==='.'?'':dim.path,'region',`r.${Math.floor(x/32)}.${Math.floor(z/32)}.mca`);if(!regions.has(relative))regions.set(relative,new Map());regions.get(relative).set(((x%32+32)%32)+((z%32+32)%32)*32,updated.raw);expected.push({x,z,old:old.raw,...updated});}
    reader.verifyStable();
    for(const[relative,replacements]of regions){const target=safePath(working.world,relative),original=readBounded(working.world,relative,256*1024*1024),bytes=replaceRegionRecords(original,replacements),tmp=target+'.worldrenew-partial';regionOriginals.set(relative,original);fs.writeFileSync(tmp,bytes,{flag:'wx'});fs.renameSync(tmp,target);}
    journal('validating');progress({phase:'Validating placed blocks',file:working.world});
    const result=inspectWorld(working.world);requireThat(result.totals.invalidChunks===0&&result.dimensions.every(d=>!d.issues.length&&d.regions.every(r=>!r.issues.length)),'PLACEMENT_VERIFY','Output region validation failed.');
    for(const[relative,replacements]of regions){
      const before=regionOriginals.get(relative),after=readBounded(working.world,relative,256*1024*1024);
      for(let slot=0;slot<1024;slot++)if(!replacements.has(slot)){
        const a=before.readUInt32BE(slot*4),b=after.readUInt32BE(slot*4);
        requireThat(Boolean(a)===Boolean(b)&&before.readUInt32BE(4096+slot*4)===after.readUInt32BE(4096+slot*4),'PLACEMENT_VERIFY','An untouched region slot changed.');
        if(a)requireThat(before.subarray((a>>>8)*4096,((a>>>8)+(a&255))*4096).equals(after.subarray((b>>>8)*4096,((b>>>8)+(b&255))*4096)),'PLACEMENT_VERIFY','An untouched chunk record changed.');
      }
    }
    const afterReader=createChunkReader(working.world,dim);
    for(const e of expected){const c=afterReader.read(e.x,e.z);requireThat(c&&sha(c.raw)===sha(e.raw),'PLACEMENT_VERIFY','Written chunk differs from the prepared chunk.');const old=readTypedNBT(e.old),current=readTypedNBT(c.raw);verifyUntouchedBlocks(plain(old),plain(current),e.x,e.z,plan.destination.bounds);requireThat(stripDerived(old,e.changed).equals(stripDerived(current,e.changed)),'PLACEMENT_VERIFY','Unrelated chunk metadata changed.');}
    const placed=captureVolume(result,dimensionKey,plan.destination.bounds);requireThat(placed.complete&&placed.voxels.every((v,i)=>stateKey(placed.palette[v])===stateKey(airMode==='skip'&&isAir(plan.source.palette[plan.source.voxels[i]])?plan.destination.palette[plan.destination.voxels[i]]:plan.source.palette[plan.source.voxels[i]])),'PLACEMENT_VERIFY','Placed block content differs from the reviewed air policy and portable build.');
    const manifest=JSON.parse(fs.readFileSync(backup.manifest,'utf8'));verifyFiles(working.world,manifest,new Set(regions.keys()));verifyFiles(backup.world,manifest);verifyFiles(destination.root,manifest);
    fs.writeFileSync(path.join(stage,'validation.json'),JSON.stringify({schema:1,status:'validated-test-copy',gameLoadTested:false,blocks:placed.stats.total,airMode,effects:plan.effects,modifiedRegions:[...regions.keys()],lightingChunks:expected.length,archiveDigest:plan.archiveDigest,warnings:plan.warnings},null,2));journal('validated-test-copy');
    const backupRelative=path.relative(stage,backup.world),worldRelative=path.relative(stage,working.world);fs.renameSync(stage,final);
    return {directory:final,world:path.join(final,worldRelative),backup:path.join(final,backupRelative),report:path.join(final,'validation.json'),blocks:placed.stats.total,airMode,effects:plan.effects};
  }catch(e){if(working)fs.rmSync(working.directory,{recursive:true,force:true});if(backup){journal('failed-working-copy-discarded');e.message+=` Verified backup retained at ${backup.world}`;}else fs.rmSync(stage,{recursive:true,force:true});throw e;}
}
