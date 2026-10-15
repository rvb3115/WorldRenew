import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyRecordTags, makeWorld, writeRegion, writeDat } from './fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { inspectRemovalSafety } from '../engine/removal-safety.js';
import { hashFile, inventory } from '../engine/safety.js';
import { preservationWorld, playerTags, playerPath, levelTags, richPlayerFields } from './preservation-fixtures.js';
import { decodeDat } from '../engine/nbt.js';
import { createChunkReader } from '../engine/chunks.js';
const ack={confirmedClosed:true,confirmedExperimental:true};
const list=values=>[9,{type:10,values}];
const hashes=root=>inventory(root).files.map(f=>[f.path,hashFile(path.join(root,f.path))]);
function setup(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-removal-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const root=makeWorld(path.join(base,'source'),{dataVersion:5023,spawn:[1024,64,1024]});return{base,root};}
function plan(f){const world=inspectWorld(f.root),c={dimension:world.dimensions.find(d=>d.id==='minecraft:overworld').key,x:0,z:0};return {world,c,review:createRegenerationReview(world,[c],[],{bufferChunks:0})};}
function record(f,store,tags){writeRegion(path.join(f.root,`dimensions/minecraft/overworld/${store}/r.0.0.mca`),[{x:0,z:0,tags}]);}
for(const [label,store,patch] of [
  ['chest inventory','region',{block_entities:list([{id:[8,'minecraft:chest'],Items:list([{id:[8,'minecraft:diamond'],count:[3,64]}])}])}],
  ['unknown block entity','region',{block_entities:list([{id:[8,'example:unknown'],UnrecognizedInventory:list([{payload:[8,'must survive']}])}])}],
  ['empty chest','region',{block_entities:list([{id:[8,'minecraft:chest'],Items:list([])}])}],
  ['inventory-bearing minecart','entities',{Entities:list([{id:[8,'minecraft:chest_minecart'],Items:list([{id:[8,'minecraft:diamond'],count:[3,64]}])}])}],
  ['ordinary mob','entities',{Entities:list([{id:[8,'minecraft:cow']}])}],
  ['wrong block entity tag type','region',{block_entities:[11,[]]}],
  ['wrong entity list element type','entities',{Entities:[9,{type:8,values:[]}]}],
  ['wrong entity coordinates','entities',{Position:[11,[1,0]]}],
  ['unknown entity version','entities',{DataVersion:[3,99999]}],
  ['legacy terrain schema','region',{TileEntities:list([])}],
])test(`${label} blocks reset without creating output or changing source`,t=>{
  const f=setup(t);record(f,store,{...emptyRecordTags(0,0,store),...patch});const before=hashes(f.root),{world,review}=plan(f);
  assert.equal(review.copyExport.eligible,false);assert.ok(review.removalSafety.blockers.length);
  assert.throws(()=>createRegeneratedCopy(world,review,f.base,ack),{code:'EXPORT_BLOCKED'});
  assert.deepEqual(hashes(f.root),before);assert.deepEqual(fs.readdirSync(f.base),['source']);
});
test('missing attachment lists and unreadable external payloads never mean empty',t=>{
  const f=setup(t),tags=emptyRecordTags(0,0);delete tags.block_entities;record(f,'region',tags);assert.equal(plan(f).review.copyExport.eligible,false);
  for(const compression of [2,4]){
    record(f,'region',emptyRecordTags(0,0));const dir=path.join(f.root,'dimensions/minecraft/overworld/region'),file=path.join(dir,'r.0.0.mca'),bytes=fs.readFileSync(file);
    bytes.writeUInt32BE(1,8192);bytes[8196]=128|compression;fs.writeFileSync(file,bytes);fs.writeFileSync(path.join(dir,'c.0.0.mcc'),'opaque or damaged data');
    const {world,review}=plan(f);assert.equal(review.copyExport.eligible,false);assert.throws(()=>createRegeneratedCopy(world,review,f.base,ack),{code:'EXPORT_BLOCKED'});
  }
});
test('bounded content review fails closed and late inventory additions invalidate prior review',t=>{
  const f=setup(t),{world,c,review}=plan(f);assert.equal(review.copyExport.eligible,true);
  const limited=inspectRemovalSafety(world,[c],()=>{},{byteBudget:1});assert.ok(limited.blockers.length);assert.equal(limited.complete,false);
  record(f,'entities',{...emptyRecordTags(0,0,'entities'),Entities:list([{id:[8,'minecraft:item'],Item:[10,{id:[8,'minecraft:diamond'],count:[3,1]}]}])});
  assert.throws(()=>createRegeneratedCopy(world,review,f.base,ack),{code:'REVIEW_STALE'});assert.deepEqual(fs.readdirSync(f.base),['source']);
});
for(const layout of ['players/data','playerdata'])test(`${layout}, embedded Player, level.dat and protected chest retain all bytes including equipment and unknown fields`,t=>{
  const f=setup(t);fs.rmSync(f.root,{recursive:true});preservationWorld(f.root);
  for(let i=0;i<2;i++)writeDat(path.join(f.root,playerPath(i)),playerTags(i,richPlayerFields));
  writeDat(path.join(f.root,'level.dat'),levelTags({Player:[10,playerTags(0,richPlayerFields)]}));
  if(layout==='playerdata')fs.renameSync(path.join(f.root,'players/data'),path.join(f.root,'playerdata'));
  const world=inspectWorld(f.root),dimension=world.dimensions.find(d=>d.id==='minecraft:overworld').key,c=x=>({dimension,x,z:0});
  const before=hashes(f.root),review=createRegenerationReview(world,[c(4)],[c(0)],{bufferChunks:1});assert.equal(review.copyExport.eligible,true,review.copyExport.blockers.join('\n'));
  const result=createRegeneratedCopy(world,review,f.base,ack);assert.deepEqual(hashes(f.root),before);assert.deepEqual(hashes(result.backup),before);
  for(const [file,sha] of before)if(file==='level.dat'||/^(players|playerdata)\//.test(file))assert.equal(hashFile(path.join(result.world,file)),sha,file);
  const playerFile=playerPath().replace('players/data',layout),player=decodeDat(fs.readFileSync(path.join(result.world,playerFile)));
  assert.equal(player.Inventory[0].components['minecraft:damage'],123);assert.equal(player.Inventory[1].components['minecraft:damage'],51);assert.equal(player.Inventory[2].tag.UnfamiliarField,'retain verbatim');
  assert.equal(player.Health,17.5);assert.equal(player.foodLevel,9);assert.equal(player.foodSaturationLevel,2.5);assert.equal(player.foodExhaustionLevel,3.25);assert.equal(player.XpP,.5);assert.equal(player.EnderItems[0].components['minecraft:container'][0].item.id,'minecraft:diamond_pickaxe');
  assert.deepEqual(decodeDat(fs.readFileSync(path.join(result.world,'level.dat'))).Data.Player,decodeDat(fs.readFileSync(path.join(f.root,'level.dat'))).Data.Player);
  const d=world.dimensions.find(d=>d.key===dimension),original=createChunkReader(f.root,d).read(0,0),preserved=createChunkReader(result.world,d).read(0,0);
  assert.deepEqual(preserved.raw,original.raw);assert.equal(preserved.nbt.block_entities[0].Items[1].components['minecraft:damage'],123);
  const validation=JSON.parse(fs.readFileSync(result.report));assert.equal(validation.levelDatByteIdentical,true);assert.equal(validation.containerAndEntityRemovalBlocked,true);
});
