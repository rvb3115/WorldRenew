import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {nbt} from './fixtures.js';
import {makeBlockWorld,state} from './transfer-fixtures.js';
import {placementWorld} from './placement-fixtures.js';
import {inspectWorld} from '../engine/world.js';
import {captureBuildArchive,saveBuildFile,readBuildFile,encodeBuild,validateBuildArchive,sha} from '../engine/build-archive.js';
import {readTypedNBT,writeTypedNBT,field,setField,tag,plain} from '../engine/typed-nbt.js';
import {previewBuildFile,createPlacedCopy,placeableState} from '../engine/copy-placement.js';
import {captureVolume} from '../engine/volumes.js';
const setup=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-build-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const bounds={minX:2,maxX:5,minY:0,maxY:3,minZ:2,maxZ:5},anchor={x:20,y:2,z:20};
const dim=w=>w.dimensions.find(d=>d.id==='minecraft:overworld').key;
const files=root=>Object.fromEntries(fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>{const p=path.join(f.parentPath,f.name);return[path.relative(root,p),sha(fs.readFileSync(p))];}));
function fixture(dir){
 const source=makeBlockWorld(path.join(dir,'source'),{version:'26.2',dataVersion:4903,block:(x,y,z)=>state(y===0?'oak_planks':x===3&&z===3?'cave_air':'stone')}),world=inspectWorld(source),file=path.join(dir,'build.wrbuild');saveBuildFile(file,captureBuildArchive(world,dim(world),bounds),[source]);
 const destination=inspectWorld(placementWorld(path.join(dir,'destination')));return{source,world,file,destination};
}
test('typed NBT preserves scalar types, long precision, arrays, list types, modified UTF and NaN payloads',()=>{
 const bytes=nbt({b:[1,-1],s:[2,300],i:[3,2147483647],l:[4,9223372036854775807n],f:[5,1.5],d:[6,NaN],bytes:[7,Buffer.from([255,0])],text:[8,'a\0😀'],list:[9,{type:2,values:[1,2]}],ints:[11,[1,-2]],longs:[12,[1n,-2n]],empty:[9,{type:10,values:[]}],nested:[10,{value:[8,'yes']}]});
 const root=readTypedNBT(bytes);assert.deepEqual(writeTypedNBT(root),bytes);setField(root,'i',tag(3,42));const next=readTypedNBT(writeTypedNBT(root));assert.equal(plain(field(next,'i')),42);assert.equal(field(next,'s').type,2);assert.equal(field(next,'list').elementType,2);assert.equal(plain(field(next,'l')),'9223372036854775807');assert.deepEqual(field(next,'d').raw,field(root,'d').raw);
});
test('portable archive survives deletion of its source and preserves every raw supporting record',t=>{
 const dir=setup(t),{source,file}=fixture(dir),build=readBuildFile(file),expected=build.volume;
 fs.rmSync(source,{recursive:true});const restored=readBuildFile(file);assert.deepEqual(restored.volume.voxels,expected.voxels);assert.deepEqual(restored.volume.palette,expected.palette);assert.ok(restored.volume.stats.air>0);assert.equal(restored.archive.records.length,3);assert.equal(restored.archive.records[0].sha256,sha(restored.decoded.get('region:0,0').raw));
});
test('inventory and typed block-entity data remain byte-exact but block unsupported relocation',t=>{
 const dir=setup(t),be={id:[8,'minecraft:chest'],x:[3,3],y:[3,1],z:[3,3],Items:[9,{type:10,values:[{Slot:[1,0],id:[8,'minecraft:diamond'],count:[3,12],custom:[4,9007199254740993n]}]}]};
 const root=makeBlockWorld(path.join(dir,'source'),{version:'26.2',dataVersion:4903,block:()=>state('stone'),blockEntities:[be]}),world=inspectWorld(root),archive=captureBuildArchive(world,dim(world),bounds),file=path.join(dir,'inventory.wrbuild');saveBuildFile(file,archive);const opened=readBuildFile(file);
 assert.equal(opened.volume.attachments.blockEntities[0].Items[0].custom,'9007199254740993');const original=readTypedNBT(opened.decoded.get('region:0,0').raw);assert.equal(field(field(original,'block_entities').value[0],'Items').value[0].value.find(v=>v.name==='Slot').type,1);
 const d=inspectWorld(placementWorld(path.join(dir,'destination'))),p=previewBuildFile(file,d,dim(d),anchor);assert.equal(p.copyEligible,false);assert.match(p.blockers.join(' '),/inventories/);
});
test('archives reject checksums, truncation, missing records, unknown sections and writes inside saves',t=>{
 const dir=setup(t),{file,world,source}=fixture(dir),bytes=fs.readFileSync(file),bad=path.join(dir,'bad.wrbuild');bytes[20]^=1;fs.writeFileSync(bad,bytes);assert.throws(()=>readBuildFile(bad),/checksum/);fs.writeFileSync(bad,bytes.subarray(0,40));assert.throws(()=>readBuildFile(bad),/Damaged/);
 const a=readBuildFile(file).archive;a.records.pop();assert.throws(()=>validateBuildArchive(a),/missing/);
 assert.throws(()=>saveBuildFile(path.join(source,'bad.wrbuild'),readBuildFile(file).archive),/inside/);assert.throws(()=>saveBuildFile(file,readBuildFile(file).archive),/new filename/);
 assert.throws(()=>captureBuildArchive(world,dim(world),{...bounds,maxY:100}),/complete/);
});
test('copy placement preserves air, all outside blocks, metadata, unrelated chunks, backup and originals',t=>{
 const dir=setup(t),{file,source,destination}=fixture(dir),before=files(destination.root),sourceBefore=files(source),plan=previewBuildFile(file,destination,dim(destination),anchor);assert.deepEqual(plan.blockers,[]);
 const result=createPlacedCopy(file,destination,dim(destination),anchor,dir,{confirmedClosed:true,reviewDigest:plan.reviewDigest});
 assert.deepEqual(files(destination.root),before);assert.deepEqual(files(result.backup),before);assert.deepEqual(files(source),sourceBefore);
 const world=inspectWorld(result.world),v=captureVolume(world,dim(world),plan.destination.bounds),original=readBuildFile(file).volume;assert.deepEqual(v.voxels,original.voxels);assert.deepEqual(v.palette,original.palette);assert.ok(fs.existsSync(result.report));assert.equal(JSON.parse(fs.readFileSync(result.report)).gameLoadTested,false);
});
test('stale reviews, open-world requests and unsupported versions cannot create copies',t=>{
 const dir=setup(t),{file,destination}=fixture(dir);assert.throws(()=>createPlacedCopy(file,destination,dim(destination),anchor,dir,{}),/Close Minecraft/);assert.throws(()=>createPlacedCopy(file,destination,dim(destination),anchor,dir,{confirmedClosed:true,reviewDigest:'forged'}),/fresh placement/);
 const archive=readBuildFile(file).archive;archive.source.version='26.3';const newer=path.join(dir,'newer.wrbuild');fs.writeFileSync(newer,encodeBuild(archive));assert.equal(previewBuildFile(newer,destination,dim(destination),anchor).copyEligible,false);
 for(const Name of ['minecraft:water','minecraft:nether_portal','minecraft:chest','minecraft:oak_stem','minecraft:cut_sandstone_stairs'])assert.equal(placeableState({Name}),false);
 assert.equal(placeableState({Name:'minecraft:oak_stairs',Properties:{waterlogged:'true'}}),false);
});
test('validation failure discards the working copy and retains a verified backup',t=>{
 const dir=setup(t),{file,destination}=fixture(dir),before=files(destination.root),plan=previewBuildFile(file,destination,dim(destination),anchor);
 assert.throws(()=>createPlacedCopy(file,destination,dim(destination),anchor,dir,{confirmedClosed:true,reviewDigest:plan.reviewDigest},p=>{if(p.phase==='Validating placed blocks')fs.writeFileSync(path.join(p.file,'level.dat'),'broken');}),/backup retained/);
 assert.deepEqual(files(destination.root),before);const stage=fs.readdirSync(dir).find(n=>n.endsWith('.partial'));assert.ok(stage);assert.match(fs.readFileSync(path.join(dir,stage,'operation.json'),'utf8'),/failed-working-copy-discarded/);
 const dirs=fs.readdirSync(path.join(dir,stage),{withFileTypes:true}).filter(d=>d.isDirectory());assert.equal(dirs.length,1);assert.deepEqual(files(path.join(dir,stage,dirs[0].name,'world')),before);
});

test('archives preserve entity passengers, POI, biome palettes and scheduled tick tags without flattening',t=>{
 const dir=setup(t),root=makeBlockWorld(path.join(dir,'source'),{version:'26.2',dataVersion:4903,block:()=>state('stone')});
 const write=(store,raw)=>{const file=path.join(root,`dimensions/minecraft/overworld/${store}/r.0.0.mca`);fs.mkdirSync(path.dirname(file),{recursive:true});const count=Math.ceil((raw.length+5)/4096),b=Buffer.alloc((2+count)*4096);b.writeUInt32BE(512+count);b.writeUInt32BE(raw.length+1,8192);b[8196]=3;raw.copy(b,8197);fs.writeFileSync(file,b);};
 const passenger={id:[8,'minecraft:chicken'],Pos:[9,{type:6,values:[3,2,3]}]};
 const entity={id:[8,'minecraft:armor_stand'],UUID:[11,[1,2,3,4]],Pos:[9,{type:6,values:[3,1,3]}],Passengers:[9,{type:10,values:[passenger]}]};
 const entities=nbt({DataVersion:[3,4903],Position:[11,[0,0]],Entities:[9,{type:10,values:[entity]}]});write('entities',entities);
 const poiRecord={pos:[4,(3n<<38n)|(3n<<12n)|1n],type:[8,'minecraft:home'],free_tickets:[3,1]};
 const poiSection={Valid:[1,1],Records:[9,{type:10,values:[poiRecord]}]};
 const poi=nbt({DataVersion:[3,4903],Sections:[10,{'0':[10,poiSection]}]});write('poi',poi);
 const world=inspectWorld(root),archive=captureBuildArchive(world,dim(world),bounds),opened=validateBuildArchive(archive);
 assert.equal(opened.summary.entities,1);assert.deepEqual(opened.decoded.get('entities:0,0').raw,entities);assert.deepEqual(opened.decoded.get('poi:0,0').raw,poi);
 const terrain=readTypedNBT(opened.decoded.get('region:0,0').raw);const section=field(terrain,'sections').value[0];setField(section,'biomes',{type:10,value:[{name:'palette',type:9,elementType:8,value:[tag(8,'minecraft:plains')]}]});
 setField(terrain,'block_ticks',{type:9,elementType:10,value:[{type:10,value:[{name:'x',...tag(3,3)},{name:'y',...tag(3,1)},{name:'z',...tag(3,3)},{name:'i',...tag(8,'minecraft:stone')},{name:'t',...tag(3,20)},{name:'p',...tag(3,0)}]}]});
 write('region',writeTypedNBT(terrain));const recaptured=captureBuildArchive(inspectWorld(root),dim(world),bounds),v=validateBuildArchive(recaptured);assert.equal(v.summary.ticks,1);assert.deepEqual(plain(field(field(readTypedNBT(v.decoded.get('region:0,0').raw),'sections').value[0],'biomes')),plain(field(section,'biomes')));
});
test('multi-chunk selections preserve content despite differing palette traversal order',t=>{
 const dir=setup(t),root=placementWorld(path.join(dir,'source'),{block:(x,y,z)=>state(x%3?'stone':'oak_planks')}),world=inspectWorld(root),b={minX:14,maxX:20,minY:0,maxY:3,minZ:14,maxZ:20};
 const a=captureBuildArchive(world,dim(world),b);assert.equal(a.records.length,12);assert.equal(validateBuildArchive(a).volume.stats.total,196);
});
test('protection and missing neighbor chunks block copy placement before creating any backup',t=>{
 const dir=setup(t),{file,destination}=fixture(dir),p=previewBuildFile(file,destination,dim(destination),anchor,()=>{},[{dimension:dim(destination),x:1,z:1}]);assert.equal(p.copyEligible,false);assert.match(p.blockers.join(' '),/protected/);
 const edge=previewBuildFile(file,destination,dim(destination),{x:2,y:2,z:2});assert.equal(edge.copyEligible,false);assert.match(edge.blockers.join(' '),/lighting border/);
});

test('Nether roof placement preserves bedrock and other dimensions across negative region boundaries',t=>{
 const dir=setup(t),source=placementWorld(path.join(dir,'roof-source'),{sections:[7,8,9],block:(x,y,z)=>state(y===127?'bedrock':y===128?'oak_planks':x===3&&z===3?'cave_air':'stone')}),dest=placementWorld(path.join(dir,'roof-destination'),{originX:-2,originZ:-2,sections:[7,8,9],block:(x,y,z)=>state(y===127?'bedrock':'stone')});
 for(const root of [source,dest])fs.cpSync(path.join(root,'dimensions/minecraft/overworld'),path.join(root,'dimensions/minecraft/the_nether'),{recursive:true});
 const world=inspectWorld(source),destination=inspectWorld(dest),dimension=world.dimensions.find(d=>d.id==='minecraft:the_nether').key,b={...bounds,minY:128,maxY:131},a={x:-12,y:136,z:-12},file=path.join(dir,'roof.wrbuild');
 saveBuildFile(file,captureBuildArchive(world,dimension,b));const before=files(dest),plan=previewBuildFile(file,destination,dimension,a);assert.deepEqual(plan.blockers,[]);
 const output=createPlacedCopy(file,destination,dimension,a,dir,{confirmedClosed:true,reviewDigest:plan.reviewDigest}),result=inspectWorld(output.world);assert.deepEqual(files(dest),before);assert.deepEqual(files(output.backup),before);
 const bedrock=captureVolume(result,dimension,{minX:-12,maxX:-9,minY:127,maxY:127,minZ:-12,maxZ:-9});assert.ok(bedrock.voxels.every(v=>bedrock.palette[v].Name==='minecraft:bedrock'));
 for(const[name,hash]of Object.entries(before))if(name.includes('/overworld/'))assert.equal(files(output.world)[name],hash);
 assert.ok(JSON.parse(fs.readFileSync(output.report)).modifiedRegions.length===4);
});

test('roof selections ending at Y255 do not invent missing terrain above the Nether build ceiling',t=>{
 const dir=setup(t),options={sections:Array.from({length:9},(_,i)=>i+7),block:(x,y,z)=>state(y===128?'oak_planks':'air')},source=placementWorld(path.join(dir,'source'),options),dest=placementWorld(path.join(dir,'destination'),options);
 for(const root of [source,dest])fs.renameSync(path.join(root,'dimensions/minecraft/overworld'),path.join(root,'dimensions/minecraft/the_nether'));
 const w=inspectWorld(source),d=inspectWorld(dest),dimension=w.dimensions[0].key,file=path.join(dir,'full-roof.wrbuild');saveBuildFile(file,captureBuildArchive(w,dimension,{...bounds,minY:128,maxY:255}));
 const p=previewBuildFile(file,d,dimension,{x:20,y:128,z:20});assert.deepEqual(p.blockers,[]);assert.equal(p.context.bounds.maxY,255);assert.equal(p.boundary.unknownFaces,0);
});
