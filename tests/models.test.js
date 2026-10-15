import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveModel,rotateBlock} from '../engine/models.js';
const faceNames=['east','west','up','down','south','north'];
const box=(from,to)=>({from,to,faces:Object.fromEntries(faceNames.map(n=>[n,{texture:'#all'}]))});
function archive(def,models){return {json:name=>name.includes('/blockstates/')?def:models[name.split('/').at(-1).replace('.json','')]??null};}
function resolve(elements,choice={},props={},extra={}){
 const a=archive({variants:{'':{model:'minecraft:block/test',...choice}}},{test:{textures:{all:'minecraft:block/stone'},elements,...extra}});
 return resolveModel(a,{Name:'minecraft:test',Properties:props});
}
const range=(m,i)=>[Math.min(...m.quads.flatMap(q=>q.points.map(p=>p[i]))),Math.max(...m.quads.flatMap(q=>q.points.map(p=>p[i])))];
test('slabs preserve half height and do not hide neighboring faces',()=>{
 const slab=resolve([box([0,0,0],[16,8,16])]);assert.deepEqual(range(slab,1),[0,.5]);assert.equal(slab.occludes,false);
 assert.equal(resolve([box([0,0,0],[16,16,16])]).occludes,true);
 const upper=resolve([box([0,8,0],[16,16,16])]);assert.deepEqual(range(upper,1),[.5,1]);
 const top=slab.quads.find(q=>q.direction===2);assert.equal(top.cull,-1);assert.deepEqual(slab.quads[0].uvs,[[1,1],[1,.5],[0,.5],[0,1]]);
});
test('stairs keep separate treads; blockstate rotations orient the upper step',()=>{
 const elements=[box([0,0,0],[16,8,16]),box([8,8,0],[16,16,16])];
 const east=resolve(elements),south=resolve(elements,{y:90}),top=resolve(elements,{x:180});
 assert.equal(east.quads.length,12);assert.equal(east.occludes,false);
 assert.ok(south.quads.slice(6).every(q=>q.points.every(p=>p[2]>=.5)));
 assert.ok(top.quads.slice(0,6).every(q=>q.points.every(p=>p[1]>=.5)));
 assert.deepEqual(rotateBlock([0,0,-1],90,0),[0,-1,0]);
});
test('multipart fence adds only connected rails, including OR / AND predicates',()=>{
 const models={post:{textures:{all:'minecraft:block/oak'},elements:[box([6,0,6],[10,16,10])]},rail:{textures:{all:'minecraft:block/oak'},elements:[box([7,6,0],[9,9,8])]}};
 const a=archive({multipart:[{apply:{model:'minecraft:block/post'}},{when:{north:'true'},apply:{model:'minecraft:block/rail'}},{when:{AND:[{east:'true'},{OR:[{waterlogged:'false'},{west:'true'}]}]},apply:{model:'minecraft:block/rail',y:90}}]},models);
 const m=resolveModel(a,{Name:'minecraft:oak_fence',Properties:{north:'true',east:'true',waterlogged:'false'}});assert.equal(m.quads.length,18);assert.deepEqual(range(m,0),[.375,1]);assert.deepEqual(range(m,2),[0,.625]);
 assert.equal(resolveModel(a,{Name:'minecraft:oak_fence',Properties:{north:'false',east:'false'}}).quads.length,6);
});
test('thin doors rotate around the block center and preserve face UV crops',()=>{
 const door=box([0,0,0],[16,16,3]);door.faces.north.uv=[0,0,16,16];
 const m=resolve([door],{y:90});assert.deepEqual(range(m,0),[.8125,1]);assert.deepEqual(range(m,2),[0,1]);assert.equal(m.occludes,false);
});
test('UV lock keeps top texture aligned after a quarter turn',()=>{
 const e=box([0,0,0],[16,16,16]);
 const locked=resolve([e],{y:90,uvlock:true}).quads.find(q=>q.direction===2),moving=resolve([e],{y:90}).quads.find(q=>q.direction===2);
 for(let i=0;i<4;i++)assert.deepEqual(locked.uvs[i],[locked.points[i][0],locked.points[i][2]]);
 assert.notDeepEqual(moving.uvs,locked.uvs);
});
test('element rotation with rescale produces finite diagonal geometry',()=>{
 const e=box([7,0,0],[9,16,16]);e.rotation={origin:[8,8,8],axis:'y',angle:45,rescale:true};const m=resolve([e]);
 assert.ok(m.quads.every(q=>q.points.flat().every(Number.isFinite)));assert.equal(m.occludes,false);assert.ok(m.quads.some(q=>q.points.some(p=>p[0]<0)));
});
test('glass and forced translucency never occlude neighboring models',()=>{
 const a=archive({variants:{'':{model:'minecraft:block/test'}}},{test:{textures:{all:{sprite:'minecraft:block/glass',force_translucent:true}},elements:[box([0,0,0],[16,16,16])]}});
 const m=resolveModel(a,{Name:'minecraft:glass'});assert.equal(m.occludes,false);assert.ok(m.quads.every(q=>q.translucent));
});
test('malformed geometry and excessive models fail before producing a partial mesh',()=>{
 assert.throws(()=>resolve([box([NaN,0,0],[16,16,16])]),/bounds/);
 assert.throws(()=>resolve(Array(257).fill(box([0,0,0],[16,16,16]))),/count/);
 const e=box([0,0,0],[16,16,16]);e.faces.east.uv=[0,0,99,16];assert.throws(()=>resolve([e]),/UVs/);
 assert.throws(()=>resolve([box([0,0,0],[16,16,16])],{y:45}),/rotation/);
});
