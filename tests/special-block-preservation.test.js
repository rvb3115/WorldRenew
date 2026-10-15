import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { state, writeBlockChunk } from './transfer-fixtures.js';
import { placementWorld } from './placement-fixtures.js';
import { richPlayerFields, playerTags, playerPath } from './preservation-fixtures.js';
import { writeDat } from './fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { captureBuildArchive, saveBuildFile, readBuildFile } from '../engine/build-archive.js';
import { createPlacedCopy, previewBuildFile, placeableState } from '../engine/copy-placement.js';
import { captureVolume } from '../engine/volumes.js';
import { stateKey, createChunkReader } from '../engine/chunks.js';
import { hashFile, inventory } from '../engine/safety.js';
import { replaceRegionRecords } from '../engine/region-writer.js';
import { readTypedNBT, field } from '../engine/typed-nbt.js';
const special=[
  state('glass'),state('blue_stained_glass'),
  state('glass_pane',{north:'true',east:'false',south:'true',west:'false',waterlogged:'false'}),
  state('oak_fence',{north:'false',east:'true',south:'false',west:'true',waterlogged:'false'}),
  state('iron_bars',{north:'true',east:'true',south:'false',west:'false',waterlogged:'false'}),
  state('nether_portal',{axis:'x'}),
  state('oak_stairs',{facing:'east',half:'top',shape:'outer_left',waterlogged:'false'}),
  state('oak_stairs',{facing:'south',half:'bottom',shape:'inner_right',waterlogged:'true'}),
  ...['bottom','top','double'].map(type=>state('stone_slab',{type,waterlogged:'false'})),
  ...['lower','upper'].map(half=>state('oak_door',{half,hinge:'right',facing:'west',open:'true',powered:'true'})),
  state('redstone_wire',{north:'side',east:'up',south:'none',west:'side',power:'15'}),
  state('repeater',{delay:'4',facing:'north',locked:'true',powered:'true'}),
  state('comparator',{facing:'south',mode:'subtract',powered:'true'}),
  state('piston',{facing:'up',extended:'true'}),state('observer',{facing:'east',powered:'true'})
];
const dim=w=>w.dimensions.find(d=>d.id==='minecraft:overworld').key;
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-special-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const hashes=root=>inventory(root).files.map(f=>[f.path,hashFile(path.join(root,f.path))]);
test('cross-chunk templates retain special-block properties and raw records while refusing unsupported placement',t=>{
  const base=setup(t),root=placementWorld(path.join(base,'source'),{originX:-1,originZ:-1,block:(x,y)=>special[((y+16)*16+x)%special.length]}),world=inspectWorld(root),bounds={minX:-1,maxX:17,minY:0,maxY:3,minZ:0,maxZ:1};
  const volume=captureVolume(world,dim(world),bounds),archive=captureBuildArchive(world,dim(world),bounds),file=path.join(base,'special.wrbuild');saveBuildFile(file,archive);
  const opened=readBuildFile(file);assert.deepEqual(Array.from(opened.volume.voxels,id=>stateKey(opened.volume.palette[id])),Array.from(volume.voxels,id=>stateKey(volume.palette[id])));
  for(const expected of special)assert.ok(opened.volume.palette.some(s=>s&&stateKey(s)===stateKey(expected)),expected.Name);
  const reader=createChunkReader(world.root,world.dimensions.find(d=>d.key===dim(world)));
  for(const record of archive.records.filter(r=>r.nbt!==null))assert.deepEqual(opened.decoded.get(`${record.store}:${record.x},${record.z}`).raw,reader.read(record.x,record.z,record.store).raw);
  const destination=inspectWorld(placementWorld(path.join(base,'destination'))),plan=previewBuildFile(file,destination,dim(destination),{x:20,y:2,z:20});
  assert.equal(plan.copyEligible,false);assert.match(plan.blockers.join(' '),/future placement adapter/);
  assert.throws(()=>createPlacedCopy(file,destination,dim(destination),{x:20,y:2,z:20},base,{confirmedClosed:true,reviewDigest:plan.reviewDigest}),{code:'PLACEMENT_BLOCKED'});
  assert.ok(!fs.readdirSync(base).some(n=>n.startsWith('WorldRenew-placement')));
});
test('special-block restrictions retain dry shapes and reject neighbor-sensitive systems, waterlogging and unknown properties',()=>{
  for(const s of special){const allowed=['minecraft:glass','minecraft:blue_stained_glass','minecraft:stone_slab'].includes(s.Name)||s.Name==='minecraft:oak_stairs'&&s.Properties.waterlogged==='false';assert.equal(placeableState(s),allowed,s.Name);}
  for(const name of ['redstone_torch','redstone_block','lever','stone_button','tripwire_hook','rail','powered_rail','hopper','dropper','dispenser','chest','barrel','white_shulker_box','iron_door'])assert.equal(placeableState(state(name)),false,name);
  assert.equal(placeableState(state('stone_slab',{type:'double',waterlogged:'true'})),false);
  assert.equal(placeableState(state('oak_stairs',{shape:'straight',future_property:'unknown'})),false);
});
test('permitted placement keeps standalone and embedded player records byte-exact, including equipment and unknown components',t=>{
  const base=setup(t),root=placementWorld(path.join(base,'source'),{block:()=>state('oak_planks')}),world=inspectWorld(root),file=path.join(base,'simple.wrbuild');saveBuildFile(file,captureBuildArchive(world,dim(world),{minX:2,maxX:3,minY:0,maxY:2,minZ:2,maxZ:3}));
  const destinationRoot=placementWorld(path.join(base,'destination'));
  const player=playerTags(0,{...richPlayerFields,DataVersion:[3,4903]});
  writeDat(path.join(destinationRoot,playerPath()),player);writeDat(path.join(destinationRoot,playerPath(1).replace('players/data','playerdata')),playerTags(1,{...richPlayerFields,DataVersion:[3,4903]}));
  writeDat(path.join(destinationRoot,'level.dat'),{Data:[10,{LevelName:[8,'Player preservation fixture'],DataVersion:[3,4903],Version:[10,{Name:[8,'26.2'],Id:[3,4903],Snapshot:[1,0]}],Player:[10,player],UnknownWorldField:[8,'retain exactly']}]});
  const chestRaw=writeBlockChunk(path.join(base,'chest-fixture.mca'),{dataVersion:4903,block:(x,y,z)=>state(x===1&&y===1&&z===1?'chest':'stone'),blockEntities:[{id:[8,'minecraft:chest'],x:[3,1],y:[3,1],z:[3,1],Items:richPlayerFields.Inventory}]});
  const region=path.join(destinationRoot,'dimensions/minecraft/overworld/region/r.0.0.mca');fs.writeFileSync(region,replaceRegionRecords(fs.readFileSync(region),new Map([[0,chestRaw]])));
  const destination=inspectWorld(destinationRoot),before=hashes(destinationRoot),anchor={x:20,y:2,z:20},plan=previewBuildFile(file,destination,dim(destination),anchor);assert.equal(plan.copyEligible,true,plan.blockers.join('\n'));
  const result=createPlacedCopy(file,destination,dim(destination),anchor,base,{confirmedClosed:true,reviewDigest:plan.reviewDigest});
  assert.deepEqual(hashes(destinationRoot),before);assert.deepEqual(hashes(result.backup),before);
  for(const [relative,sha] of before)if(relative==='level.dat'||/^(playerdata|players)\//.test(relative))assert.equal(hashFile(path.join(result.world,relative)),sha,relative);
  const preserved=createChunkReader(result.world,destination.dimensions.find(d=>d.key===dim(destination))).read(0,0);
  assert.deepEqual(field(readTypedNBT(preserved.raw),'block_entities'),field(readTypedNBT(chestRaw),'block_entities'),'Container data outside the placement remains typed and byte-exact even inside a lighting-border chunk.');
});
