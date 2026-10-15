import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nbt, writeDat } from './fixtures.js';
import { sectionFixture, state } from './transfer-fixtures.js';
import { makeTerrainWorld, writeTerrainRegion } from './terrain-fixtures.js';
import { parseNBT } from '../engine/nbt.js';
import { decodeSection } from '../engine/chunks.js';
import { inspectWorld } from '../engine/world.js';
import { createTerrainReader, projectTerrain, terrainOptions } from '../engine/terrain.js';
import { terrainSupport } from '../engine/terrain-policy.js';
import { regenerationExportPolicy } from '../engine/versions.js';
import { captureVolume } from '../engine/volumes.js';
const metadata = { version: '1.21.11', dataVersion: 4671, versionId: 4671, snapshot: false };
const dimension = { id: 'minecraft:overworld', path: '.', key: 'minecraft:overworld|.' };
const options = () => terrainOptions(metadata, dimension);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = root => fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(e.parentPath,e.name);return [path.relative(root,file),hash(fs.readFileSync(file))];});
function chunk(block=()=>state('air')) {
  return parseNBT(nbt({ DataVersion:[3,4671], xPos:[3,-1], zPos:[3,0], yPos:[3,-4], Status:[8,'minecraft:full'], sections:[9,{type:10,values:[
    {Y:[1,-5],BlockLight:[7,Buffer.alloc(2048)]},
    ...Array.from({length:24},(_,i)=>sectionFixture(i-4,block)),
    {Y:[1,20],SkyLight:[7,Buffer.alloc(2048,255)]}
  ]}] }));
}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-12111-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('1.21.11 exact metadata enables only the terrain adapter; other and future versions remain gated', () => {
  assert.equal(terrainSupport(metadata,dimension),null);
  for(const changed of [{version:'1.21.10'},{version:'1.21.11-pre1'},{snapshot:true},{dataVersion:4670},{versionId:4672}])assert.ok(terrainSupport({...metadata,...changed},dimension));
  assert.ok(terrainSupport(metadata,{id:'example:custom'}));
  assert.ok(regenerationExportPolicy(metadata,[dimension]).blockers.length>0);
  const future=chunk();future.DataVersion=5023;
  assert.throws(()=>projectTerrain(future,options(),dimension.id),{code:'TERRAIN_UNSUPPORTED'});
});
test('1.21.11 legacy compound states produce actual water, terrain, foliage and roof heights without changing raw data', () => {
  const data=chunk((x,y,z)=>state(x<4&&y<=62?'water':x===8&&y===90?'oak_stairs':x===10&&y===80?'oak_leaves':x>=4&&y<=64+z?'grass_block':'air',x===8&&y===90?{facing:'north',half:'bottom',shape:'straight',waterlogged:'false'}:undefined));
  const before=structuredClone(data),tile=projectTerrain(data,options(),dimension.id);
  assert.equal(tile.status,'ready');assert.equal(tile.heights[0],62);assert.equal(tile.palette[tile.ids[0]],'minecraft:water');
  assert.equal(tile.heights[8],90);assert.equal(tile.palette[tile.ids[8]],'minecraft:oak_stairs');assert.equal(tile.heights[10],80);assert.equal(tile.heights[255],79);
  assert.ok(decodeSection(data.sections.find(s=>s.Y===5)).palette.some(s=>s.Properties?.facing==='north'));
  assert.deepEqual(structuredClone(data),before);
});
test('complete single-state air and outside-height light sections are accepted; absent block sections stay unknown', () => {
  const data=chunk(),tile=projectTerrain(data,options(),dimension.id);
  assert.equal(tile.ids.every(id=>id===0),true);assert.equal(tile.status,'ready');
  data.sections.find(s=>s.Y===10).block_states=undefined;
  assert.throws(()=>projectTerrain(data,options(),dimension.id),{code:'TERRAIN_SECTION_MISSING'});
});
test('1.21.11 does not accept compact or mixed palette schemas under a trusted version number', () => {
  for(const entry of ['minecraft:air',{'':'minecraft:air'},{id:'minecraft:air'},{Name:'minecraft:air',id:'minecraft:stone'},{Name:'minecraft:air',properties:{x:'y'}}]){
    const data=chunk();data.sections.find(s=>s.Y===0).block_states.palette=[entry];
    assert.throws(()=>projectTerrain(data,options(),dimension.id),{code:'TERRAIN_SCHEMA'});
  }
  const data=chunk();data.sections.find(s=>s.Y===0).block_states.palette=[{Name:'minecraft:grass_block',Properties:{snowy:1}}];
  assert.throws(()=>projectTerrain(data,options(),dimension.id),{code:'BLOCK_STATE'});
});
test('malformed roots, incomplete generation, duplicate heights and unsupported vertical layouts are rejected', () => {
  for(const patch of [{Level:{}},{Sections:[]},{xPos:'0'},{Status:'minecraft:noise'}]){
    assert.throws(()=>projectTerrain(Object.assign(chunk(),patch),options(),dimension.id),{code:'TERRAIN_SCHEMA'});
  }
  for(const yPos of [undefined,0,-8])assert.throws(()=>projectTerrain(Object.assign(chunk(),{yPos}),options(),dimension.id),{code:'TERRAIN_UNSUPPORTED'});
  const duplicate=chunk();duplicate.sections.push(duplicate.sections[1]);assert.throws(()=>projectTerrain(duplicate,options(),dimension.id),{code:'SECTION_DUPLICATE'});
  const outside=chunk();outside.sections[0].block_states={palette:[{Name:'minecraft:stone'}]};assert.throws(()=>projectTerrain(outside,options(),dimension.id),{code:'TERRAIN_UNSUPPORTED'});
});
test('independent 5-bit padded words retain indices across word boundaries; bad indices and lengths fail', () => {
  // 12 entries per 64-bit word, four padding bits; literal words are independent of sectionFixture.
  const colors=['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];
  const palette=[{Name:'minecraft:air'},...colors.map(color=>({Name:`minecraft:${color}_wool`}))];
  const words=Array(342).fill('0');words[0]='0x5a928398a418820';words[1]='0x31483104107b9ac';
  words[0]=BigInt(words[0]).toString();words[1]=BigInt(words[1]).toString();
  const data=chunk();const section=data.sections.find(s=>s.Y===0);section.block_states={palette,data:words};
  const decoded=decodeSection(section);assert.deepEqual([...decoded.indices.slice(0,17)],Array.from({length:17},(_,i)=>i));
  const tile=projectTerrain(data,options(),dimension.id);assert.equal(tile.heights[12],0);assert.equal(tile.palette[tile.ids[12]],'minecraft:blue_wool');
  section.block_states.data[0]='31';assert.throws(()=>projectTerrain(data,options(),dimension.id),{code:'BLOCK_INDEX'});
  section.block_states.data.pop();assert.throws(()=>projectTerrain(data,options(),dimension.id),{code:'BLOCK_DATA'});
});
test('signed 64-bit palette words preserve high-bit values, not negative palette indices', () => {
  const data=chunk(),section=data.sections.find(s=>s.Y===0);
  section.block_states={palette:Array.from({length:9},(_,i)=>({Name:i?'minecraft:stone':'minecraft:air'})),data:Array(256).fill('0')};
  section.block_states.data[0]='-9223372036854775808';
  assert.equal(decodeSection(section).indices[15],8);assert.equal(projectTerrain(data,options(),dimension.id).heights[15],0);
});
test('legacy region/DIM-1/DIM1 worlds render with feature metadata intact and retain unsupported write gates', t => {
  const root=makeTerrainWorld(temp(t),{version:'1.21.11',dataVersion:4671}),before=snapshot(root),world=inspectWorld(root);
  assert.equal(world.metadata.configuration.generationSource,'level.dat:Data.WorldGenSettings');assert.ok(world.metadata.configuration.enabledFeatures.includes('minecraft:trade_rebalance'));
  assert.deepEqual(world.dimensions.map(d=>d.path).sort(),['.','DIM-1','DIM1'].sort());
  const reader=createTerrainReader(world),overworld=world.dimensions.find(d=>d.id===dimension.id);
  const request={dimension:overworld.key,chunks:[{x:-1,z:0},{x:-1,z:-1},{x:6,z:4}]};const tiles=reader.batch(request).tiles;
  assert.deepEqual(tiles.map(t=>t.status),['ready','absent','unreadable']);assert.equal(tiles[2].code,'TERRAIN_SCHEMA');
  const nether=world.dimensions.find(d=>d.id==='minecraft:the_nether');
  const cavern=reader.batch({dimension:nether.key,chunks:[{x:0,z:0}]}).tiles[0],roof=reader.batch({dimension:nether.key,mode:'roof',chunks:[{x:0,z:0}]}).tiles[0];
  assert.equal(cavern.heights[0],45);assert.equal(roof.heights[0],140);
  const end=world.dimensions.find(d=>d.id==='minecraft:the_end'),tile=reader.batch({dimension:end.key,chunks:[{x:0,z:0}]}).tiles[0];assert.equal(tile.heights[0],64);assert.equal(tile.ids[15],0);
  assert.throws(()=>captureVolume(world,overworld.key,{minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1}),{code:'VOLUME_VERSION'});
  assert.ok(regenerationExportPolicy(world.metadata,[overworld]).blockers.length>0);assert.deepEqual(snapshot(root),before);
});
test('unsupported older/mixed chunk versions remain explicit while known 1.21.11 chunks can render in a newer world', t => {
  const root=temp(t);writeDat(path.join(root,'level.dat'),{Data:[10,{DataVersion:[3,5023],Version:[10,{Name:[8,'26.3'],Id:[3,5023],Snapshot:[1,0]}]}]});
  writeTerrainRegion(path.join(root,'region/r.0.0.mca'),[{x:0,z:0,dataVersion:4671,block:(_x,y)=>state(y<=64?'stone':'air')},{x:1,z:0,dataVersion:4788,block:()=>state('air')}]);
  const world=inspectWorld(root),tiles=createTerrainReader(world).batch({dimension:world.dimensions[0].key,chunks:[{x:0,z:0},{x:1,z:0}]}).tiles;
  assert.equal(tiles[0].status,'ready');assert.equal(tiles[1].status,'unsupported');assert.match(tiles[1].message,/4788/);
});
