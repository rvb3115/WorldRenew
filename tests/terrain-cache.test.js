import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createTerrainReader} from '../engine/terrain.js';
import {TerrainDiskCache} from '../engine/terrain-disk-cache.js';
import {makeWorld} from './fixtures.js';
import {writeBlockChunk,state} from './transfer-fixtures.js';
import {inspectWorld} from '../engine/world.js';
import {CompactOverview,OverviewQueue} from '../ui/terrain-overview.js';
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'wr-terrain-cache-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const root=makeWorld(path.join(work,'world'),{dataVersion:5023,sections:Array.from({length:24},(_,i)=>i-4),version:'26.3'}),file=path.join(root,'dimensions/minecraft/overworld/region/r.0.0.mca');
  writeBlockChunk(file,{dataVersion:5023,sections:Array.from({length:24},(_,i)=>i-4)});const world=inspectWorld(root),dimension=world.dimensions.find(d=>d.id==='minecraft:overworld').key;
  return {root,file,world,dimension,cacheDirectory:path.join(work,'cache')};
}
const regionRequest=f=>({dimension:f.dimension,regions:[{rx:0,rz:0}]});
const chunkRequest=f=>({dimension:f.dimension,chunks:[{x:0,z:0}],summaryOnly:true});
test('persistent summaries warm without decoding, isolate mode/dimension/world and never write sources',t=>{
  const f=fixture(t),before=digest(f.file),reader=createTerrainReader(f.world,{cacheDirectory:f.cacheDirectory});
  const cold=reader.batch(chunkRequest(f));assert.equal(cold.summaries[0].state,1);assert.equal(cold.tiles.length,0);
  const warm=createTerrainReader(f.world,{cacheDirectory:f.cacheDirectory}),result=warm.overview(regionRequest(f));
  assert.equal(result.regions[0].entries.length,1);assert.equal(result.decoded,0);assert.equal(result.diskHits,1);
  assert.equal(warm.overview({...regionRequest(f),mode:'cutaway',y:10}).regions[0].entries.length,0);
  const copied=path.join(path.dirname(f.root),'copy');fs.cpSync(f.root,copied,{recursive:true});
  assert.equal(createTerrainReader(inspectWorld(copied),{cacheDirectory:f.cacheDirectory}).overview(regionRequest(f)).regions[0].entries.length,0);
  assert.equal(digest(f.file),before);
});
test('changed regions require a fresh index and invalidate cached colors after rescan',t=>{
  const f=fixture(t),reader=createTerrainReader(f.world,{cacheDirectory:f.cacheDirectory});reader.batch(chunkRequest(f));
  writeBlockChunk(f.file,{dataVersion:5023,sections:Array.from({length:24},(_,i)=>i-4),block:(x,y,z)=>state(y<=55?'gold_block':'air')});
  assert.throws(()=>reader.overview(regionRequest(f)),{code:'WORLD_CHANGED'});
  const fresh=createTerrainReader(inspectWorld(f.root),{cacheDirectory:f.cacheDirectory});
  assert.equal(fresh.overview(regionRequest(f)).regions[0].entries.length,0);
  assert.equal(fresh.batch(chunkRequest(f)).summaries[0].state,1);
});
test('external payload changes invalidate summaries even when region bytes are unchanged',t=>{
  const f=fixture(t);writeBlockChunk(f.file,{dataVersion:5023,sections:Array.from({length:24},(_,i)=>i-4),external:true});
  const world=inspectWorld(f.root),reader=createTerrainReader(world,{cacheDirectory:f.cacheDirectory});reader.batch(chunkRequest(f));
  const before=digest(f.file),ext=path.join(path.dirname(f.file),'c.0.0.mcc');fs.unlinkSync(ext);
  assert.equal(reader.overview(regionRequest(f)).regions[0].entries.length,0);
  assert.equal(reader.batch(chunkRequest(f)).summaries[0].state,3);
  assert.equal(digest(f.file),before);
});
test('corrupted/truncated/schema-mismatched cache is a miss, not ready or empty terrain',t=>{
  const f=fixture(t),cache=new TerrainDiskCache(f.cacheDirectory,f.world);
  for(const mutate of [d=>({...d,schema:999}),d=>({...d,digest:'bad'}),d=>({...d,entries:[[0,1,0],[0,1,0]]}),()=>'{']){
    cache.write('key','stamp',[[0,1,0xabcdef]]);const file=path.join(f.cacheDirectory,cache.name('key')),original=JSON.parse(fs.readFileSync(file));
    const value=mutate(original);fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));assert.equal(cache.read('key','stamp'),null);
  }
  cache.write('key','stamp',[[0,1,123]]);assert.equal(cache.read('key','different'),null);
});
test('disk cache evicts within byte/file quotas, refuses source destinations and ignores symlink reads',t=>{
  const f=fixture(t),cache=new TerrainDiskCache(f.cacheDirectory,f.world,{maxBytes:1500,maxFiles:3});
  for(let i=0;i<20;i++)cache.write('key'+i,'stamp',[[0,1,42]]);
  assert.ok(cache.stats.bytes<=1500);assert.ok(cache.stats.files<=3);assert.equal(fs.readdirSync(f.cacheDirectory).filter(n=>n.endsWith('.json')).length,3);
  const bad=new TerrainDiskCache(path.join(f.root,'cache'),f.world);assert.ok(bad.warning);assert.equal(fs.existsSync(path.join(f.root,'cache')),false);
  const outside=path.join(path.dirname(f.root),'outside');fs.writeFileSync(outside,'private');const link=path.join(f.cacheDirectory,cache.name('link'));fs.symlinkSync(outside,link);
  assert.equal(cache.read('link','stamp'),null);assert.equal(fs.readFileSync(outside,'utf8'),'private');
});
test('one million saved chunks receive complete coverage with bounded compact memory and no duplicate work',()=>{
  const n=1000000,chunks=Array.from({length:n},(_,x)=>({x,z:0})),index=new Map(chunks.map((c,i)=>[`${c.x},0`,i])),coarse=new CompactOverview(index),queue=new OverviewQueue(coarse);
  assert.equal(coarse.bytes,5000000);
  for(let i=0;i<n;i+=1024)queue.add({chunks:chunks.slice(i,i+1024)});
  let seen=0;while(queue.pending){const batch=queue.take(16);assert.ok(batch.length<=16);for(const c of batch){const id=`${c.x},0`;assert.equal(coarse.has(id),false);coarse.set(id,{state:c.x%2?1:5,rgb:0xabcdef});seen++;}}
  assert.equal(seen,n);assert.equal(coarse.completed,n);assert.equal(coarse.counts[5],500000);assert.equal(coarse.get('0,0').code,'CHUNK_STATUS');
});

test('region header reuse stays bounded and cannot conceal changed allocations',async t=>{
  const {createChunkReader}=await import('../engine/chunks.js'),f=fixture(t),dimension=f.world.dimensions.find(d=>d.key===f.dimension),regionCache=new Map();
  const first=createChunkReader(f.root,dimension,{regionCache});first.read(0,0);first.verifyStable();const header=[...regionCache.values()][0];
  const next=createChunkReader(f.root,dimension,{regionCache});next.read(0,0);assert.equal([...regionCache.values()][0].region,header.region);
  fs.writeFileSync(f.file,Buffer.alloc(100));assert.throws(()=>createChunkReader(f.root,dimension,{regionCache}).read(0,0),{code:'REGION_HEADER'});
});

test('canceled/rapid dimension requests cannot advance a newer activation or leak coordinates',async t=>{
  const {TerrainMap}=await import('../ui/terrain-map.js');
  const previous=globalThis.document;globalThis.document={body:{classList:{contains:()=>false}}};t.after(()=>{globalThis.document=previous;});
  const region={rx:0,rz:0,path:'region/r.0.0.mca',chunks:[{x:0,z:0,valid:true}],issues:[]};
  const a={key:'a',id:'minecraft:overworld',regions:[region],issues:[]},b={key:'b',id:'minecraft:the_nether',regions:[region],issues:[]};
  const world={metadata:{version:'26.3',dataVersion:5023,versionId:5023,snapshot:false}};
  let resolve;const map=new TerrainMap({terrainTiles:()=>new Promise(r=>{resolve=r;})},()=>{});map.schedule=()=>{};
  map.reset(world,a,1,'surface',80);const first=map.load();map.reset(world,b,1,'caverns',64);map.reset(world,a,1,'surface',80);
  resolve({result:{regions:[{rx:0,rz:0,sourceStamp:'first',entries:[[0,1,0x112233]]}]}});await first;
  assert.equal(map.state.validateCursor,0);assert.equal(map.coarse.completed,0);
  const valid=map.load();resolve({result:{regions:[{rx:0,rz:0,sourceStamp:'first',entries:[]}]}});await valid;
  const decode=map.load();map.reset(world,b,1,'caverns',64);resolve({result:{tiles:[],summaries:[{x:0,z:0,state:1,rgb:0x112233}]}});await decode;
  assert.equal(map.coarse.completed,0);map.reset(world,a,1,'surface',80);assert.equal(map.coarse.completed,1);assert.equal(map.regionReady(map.state,0,0),false,'Returning cached data is validated before display.');
  const changed=map.load();resolve({result:{regions:[{rx:0,rz:0,sourceStamp:'changed',entries:[]}]}});await changed;
  assert.equal(map.coarse.completed,0,'External source changes discard retained color.');
});
