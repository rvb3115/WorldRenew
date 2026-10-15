import test from 'node:test';
import assert from 'node:assert/strict';
import {CompactOverview,OverviewQueue} from '../ui/terrain-overview.js';
import {TerrainMap} from '../ui/terrain-map.js';

const key=c=>`${c.x},${c.z}`;
function region(rx){return {rx,rz:0,path:`region/r.${rx}.0.mca`,issues:[],chunks:Array.from({length:1024},(_,i)=>({x:rx*32+i%32,z:Math.floor(i/32),valid:true}))};}
test('first coverage pass samples actual chunks across regions, then preserves region locality',()=>{
  const regions=Array.from({length:80},(_,i)=>region(i)),chunks=regions.flatMap(r=>r.chunks);
  const coarse=new CompactOverview(new Map(chunks.map((c,i)=>[key(c),i]))),queue=new OverviewQueue(coarse);
  regions.forEach(r=>queue.add(r));
  for(let i=0;i<80;i++){
    const batch=queue.take(16);assert.equal(batch.length,16);
    assert.deepEqual([...new Set(batch.map(c=>Math.floor(c.x/32)))],[i]);
    assert.equal(new Set(batch.map(c=>Math.floor(c.z/8)*4+Math.floor((c.x%32)/8))).size,16);
    for(const c of batch)coarse.set(key(c),{state:1,rgb:0x123456});
  }
  assert.equal(coarse.completed,1280);assert.equal(coarse.has('0,0'),false,'Uninspected neighbors stay pending.');
  for(let i=0;i<8;i++){const batch=queue.take(16);assert.ok(batch.every(c=>c.x<32));for(const c of batch){assert.equal(coarse.has(key(c)),false);coarse.set(key(c),{state:1,rgb:0x123456});}}
});

test('pause stops background work while visible detail validates and loads first with one request in flight',async t=>{
  const old=globalThis.document,element={dataset:{},textContent:''};
  globalThis.document={body:{classList:{contains:()=>false}},getElementById:()=>element};t.after(()=>{globalThis.document=old;});
  const regions=Array.from({length:80},(_,i)=>region(i)),dimension={key:'ow',id:'minecraft:overworld',regions,issues:[]};
  const world={metadata:{version:'26.3',dataVersion:5023,versionId:5023,snapshot:false}},requests=[];let resolve;
  const map=new TerrainMap({terrainTiles:request=>{requests.push(request);return new Promise(r=>{resolve=r;});}},()=>{});map.schedule=()=>{};
  map.reset(world,dimension,1,'surface',64);map.setBackgroundPaused(true);
  await map.load();assert.equal(requests.length,0);
  map.requestWindow([{x:79*32,z:0}]);const validation=map.load();await map.load();assert.equal(requests.length,1);
  assert.deepEqual(requests[0].regions,[{rx:79,rz:0}]);
  resolve({result:{regions:[{rx:79,rz:0,sourceStamp:'same',entries:[]}]}});await validation;
  const detail=map.load();assert.equal(requests[1].summaryOnly,false);assert.deepEqual(requests[1].chunks,[{x:79*32,z:0}]);
  resolve({result:{tiles:[{x:79*32,z:0,status:'unreadable',message:'test'}],summaries:[{x:79*32,z:0,state:3,rgb:0}]}});await detail;
  await map.load();assert.equal(requests.length,2);assert.equal(map.coarse.counts[0],81919);
  map.describe();assert.match(element.textContent,/Overview paused/);assert.match(element.textContent,/1 unreadable/);assert.match(element.textContent,/81,919 still pending/);
  map.setBackgroundPaused(false);const resumed=map.load();assert.equal(requests.length,3);assert.equal(requests[2].kind,'overview');
  resolve({result:{regions:requests[2].regions.map(r=>({...r,sourceStamp:'same',entries:[]}))}});await resumed;
});

test('sustained busy replies keep visible and background retries bounded and recover without inventing terrain',async t=>{
  const old=globalThis.document,element={dataset:{},textContent:''};
  globalThis.document={body:{classList:{contains:()=>false}},getElementById:()=>element};t.after(()=>{globalThis.document=old;});
  const r=region(0),dimension={key:'ow',id:'minecraft:overworld',regions:[r],issues:[]};
  const world={metadata:{version:'26.3',dataVersion:5023,versionId:5023,snapshot:false}};let busy=true,requests=0;
  const map=new TerrainMap({terrainTiles:async request=>{
    requests++;
    if(request.kind==='overview')return {result:{regions:[{rx:0,rz:0,sourceStamp:'same',entries:[]}]}};
    if(busy)return {error:{code:'TERRAIN_BUSY'}};
    return {result:{tiles:request.summaryOnly?[]:request.chunks.map(c=>({...c,status:'absent'})),summaries:request.chunks.map(c=>({...c,state:2,rgb:0}))}};
  }},()=>{});map.schedule=()=>{};map.reset(world,dimension,1,'surface',64);
  await map.load();map.setBackgroundPaused(true);map.requestWindow([{x:0,z:0}]);
  for(let i=0;i<100;i++)await map.load();
  assert.equal(map.state.retry.length,0);assert.equal(map.coarse.completed,0);
  busy=false;await map.load();assert.equal(map.coarse.get('0,0').status,'absent');
  const pausedRequests=requests;await map.load();assert.equal(requests,pausedRequests);
  busy=true;map.setBackgroundPaused(false);map.requestWindow([]);
  for(let i=0;i<100;i++){await map.load();assert.equal(map.state.retry.length,16);}
  assert.equal(new Set(map.state.retry.map(key)).size,16);assert.equal(map.coarse.completed,1);
  busy=false;await map.load();assert.equal(map.state.retry.length,0);assert.equal(map.coarse.completed,17);
});
