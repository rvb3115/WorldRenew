import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSection, createChunkReader } from '../engine/chunks.js';
import { captureVolume, volumeBlock, validateBounds } from '../engine/volumes.js';
import { previewTransfer, DIFFERENCE } from '../engine/transfers.js';
import { inspectWorld } from '../engine/world.js';
import { parseNBT } from '../engine/nbt.js';
import { nbt } from './fixtures.js';
import { makeBlockWorld, writeBlockChunk, sectionFixture, state, buildBlock } from './transfer-fixtures.js';

const bounds = { minX: 2, maxX: 12, minY: -8, maxY: 24, minZ: 2, maxZ: 12 };
function setup(t, options = {}) { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worldrenew-blocks-')); t.after(()=>fs.rmSync(base,{recursive:true,force:true})); const root = makeBlockWorld(path.join(base,'source'),options); const world=inspectWorld(root); return {base,root,world,dimension:world.dimensions[0].key}; }
test('modern palettes decode 4, 5, 6, 9 and 12 bits without spanning word boundaries', () => {
  for (const length of [2,17,33,257,2049]) {
    const section=sectionFixture(0,(x,y,z)=>state(`block_${(y*256+z*16+x)%length}`));
    const decoded=decodeSection(parseNBT(nbt({s:[10,section]})).s);
    for(let i=0;i<4096;i++) assert.equal(decoded.palette[decoded.indices[i]].Name,`minecraft:block_${i%length}`);
  }
});
test('single palettes preserve properties; bad indices and word lengths fail', () => {
  assert.equal(decodeSection({Y:0,block_states:{palette:[state('oak_log',{axis:'x'})]}}).palette[0].Properties.axis,'x');
  assert.throws(()=>decodeSection({Y:0,block_states:{palette:[state('air'),state('stone')],data:[]}}),/word count/);
  assert.throws(()=>decodeSection({Y:0,block_states:{palette:[state('air'),state('stone')],data:Array(256).fill('-1')}}),/out of range/);
});
test('capture preserves underground room air, roof properties and a sky platform', t => {
  const {world,dimension}=setup(t,{block:buildBlock}); const v=captureVolume(world,dimension,bounds);
  assert.equal(v.complete,true); assert.equal(v.stats.unknown,0); assert.equal(v.stats.total,11*11*33);
  assert.equal(volumeBlock(v,5,-3,5).Name,'minecraft:cave_air'); assert.equal(volumeBlock(v,5,6,5).Properties.facing,'north');
  assert.equal(volumeBlock(v,5,20,5).Name,'minecraft:quartz_block'); assert.equal(volumeBlock(v,5,19,5).Name,'minecraft:air');
  assert.equal(v.stats.air+v.stats.nonAir,v.stats.total);
});
test('block coordinates remain correct across negative chunks and negative section Y',t=>{
  const {world,dimension}=setup(t,{x:-1,z:-1,block:(x,y,z)=>state(x===15&&z===15&&y===-1?'gold_block':'air')});
  const v=captureVolume(world,dimension,{minX:-2,maxX:-1,minY:-2,maxY:-1,minZ:-2,maxZ:-1}); assert.equal(volumeBlock(v,-1,-1,-1).Name,'minecraft:gold_block');
});
for (const compression of [1,2,3]) test(`payload compression ${compression} supports internal and external records`,t=>{
  const {root,world,dimension}=setup(t,{block:()=>state('stone'),compression}); assert.equal(captureVolume(world,dimension,bounds).stats.nonAir,3993);
  writeBlockChunk(path.join(root,'dimensions/minecraft/overworld/region/r.0.0.mca'),{block:()=>state('stone'),compression,external:true}); assert.equal(captureVolume(world,dimension,bounds).stats.nonAir,3993);
});
test('missing chunks and absent sections stay unknown rather than air',t=>{
  const {world,dimension}=setup(t); const v=captureVolume(world,dimension,{minX:15,maxX:16,minY:0,maxY:0,minZ:0,maxZ:0});
  assert.equal(v.stats.air,1);assert.equal(v.stats.unknown,1);assert.equal(v.complete,false);
  const high=captureVolume(world,dimension,{minX:0,maxX:0,minY:64,maxY:64,minZ:0,maxZ:0});assert.equal(high.stats.unknown,1);
});
test('unfinished chunks, unsupported compression and old versions cannot look complete',t=>{
  const {root,world,dimension}=setup(t,{status:'minecraft:noise'});assert.equal(captureVolume(world,dimension,bounds).complete,false);
  writeBlockChunk(path.join(root,'dimensions/minecraft/overworld/region/r.0.0.mca'),{compression:4});assert.equal(captureVolume(world,dimension,bounds).complete,false);
  const old=inspectWorld(makeBlockWorld(path.join(root,'other'),{version:'1.21.11'}));assert.throws(()=>captureVolume(old,old.dimensions[0].key,bounds),/header-only/);
});
test('invalid and oversized bounds are rejected before allocation',()=>{
  assert.throws(()=>validateBounds({...bounds,minY:1.5}),/whole/);assert.throws(()=>validateBounds({...bounds,maxX:1}),/maximum/);assert.throws(()=>validateBounds({...bounds,maxX:9999}),/Preview limit/);
});
test('selected block entities are captured without transforming inventories',t=>{
  const {world,dimension}=setup(t,{block:buildBlock,blockEntities:[
    {id:[8,'minecraft:chest'],x:[3,5],y:[3,1],z:[3,5],Items:[9,{type:10,values:[{id:[8,'minecraft:diamond'],count:[3,12]}]}]},
    {id:[8,'minecraft:chest'],x:[3,15],y:[3,1],z:[3,15]}
  ]});
  const v=captureVolume(world,dimension,bounds);assert.equal(v.attachments.blockEntities.length,1);assert.equal(v.attachments.blockEntities[0].Items[0].count,12);assert.equal(v.attachments.entityCount,null);
});
test('exact placement flags carved rooms, overwritten ground and fluid boundaries',t=>{
  const {base,world,dimension}=setup(t,{block:buildBlock});const dest=inspectWorld(makeBlockWorld(path.join(base,'dest'),{block:(x,y,z)=>state(y<10?'dirt':'water')}));
  const p=previewTransfer(world,dimension,bounds,dest,dest.dimensions[0].key,{x:2,y:-8,z:2});
  assert.ok(p.counts.carved>0);assert.ok(p.counts.overwritten>0);assert.ok(p.boundary.fluidFaces>0);assert.equal(p.executable,false);assert.equal(p.source.complete,true);
  assert.equal(Object.values(p.counts).reduce((a,b)=>a+b,0),p.source.stats.total);assert.ok(p.differences.includes(DIFFERENCE.carved));
});
test('identical placement preserves air variants and produces no differences',t=>{
  const {world,dimension}=setup(t,{block:buildBlock});const p=previewTransfer(world,dimension,bounds,world,dimension,{x:2,y:-8,z:2});assert.equal(p.counts.unchanged,3993);assert.equal(p.counts.carved,0);assert.equal(p.counts.overwritten,0);
});
test('unknown destination chunks block preview readiness; sky support stays advisory',t=>{
  const {base,world,dimension}=setup(t,{block:buildBlock}), dest=inspectWorld(makeBlockWorld(path.join(base,'dest')));
  const p=previewTransfer(world,dimension,{minX:4,maxX:10,minY:20,maxY:20,minZ:4,maxZ:10},dest,dest.dimensions[0].key,{x:4,y:20,z:4});
  assert.equal(p.boundary.unsupportedBottomBlocks,49);assert.ok(p.warnings.some(w=>w.includes('sky build')));
  const missing=previewTransfer(world,dimension,bounds,dest,dest.dimensions[0].key,{x:100,y:0,z:100});assert.equal(missing.counts.unknown,3993);assert.ok(missing.blockers.some(b=>b.includes('Destination selection')));
});
test('reader detects storage replacement after a scan instead of claiming a stable capture',t=>{
  const {root,world}=setup(t);const reader=createChunkReader(root,world.dimensions[0]);reader.block(1,1,1);
  fs.writeFileSync(path.join(root,'dimensions/minecraft/overworld/region/r.0.0.mca'),Buffer.alloc(0));assert.throws(()=>reader.verifyStable(),/changed/);
});
