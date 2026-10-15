import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {topographicWindow,surfaceGeometry,pickedColumn,TOPO_CHUNK_LIMIT,TOPO_TRIANGLE_LIMIT} from '../ui/topography-geometry.js';
function tile(x=0,z=0){return{x,z,status:'ready',heights:new Int16Array(256).fill(64),ids:new Uint16Array(256).fill(1),palette:['','minecraft:grass_block'],rgba:new Uint8Array(1024).fill(150)};}
test('surface window stays bounded at negative, huge and border coordinates',()=>{
  for(const [x,z] of [[0,0],[-1,-17],[29000000,-29000000],[30000000,30000000]]){
    const cells=topographicWindow(x,z);assert.ok(cells.length<=TOPO_CHUNK_LIMIT);assert.equal(new Set(cells.map(c=>`${c.x},${c.z}`)).size,cells.length);
    assert.deepEqual(cells[0],{x:Math.floor(x/16),z:Math.floor(z/16)});
  }
  assert.throws(()=>topographicWindow(NaN,0));
});
test('topographic heights are real block tops and chunk boundaries follow each surface column',()=>{
  const data=tile(-2,3);data.heights[0]=90;const before=structuredClone(data),geometry=surfaceGeometry(data);
  assert.equal(Math.max(...geometry.positions.filter((_,i)=>i%3===1)),91);assert.ok(geometry.grid.includes(91.08000183105469));
  assert.ok(geometry.positions.length/9<=256*10);assert.deepEqual(data,before);
  assert.deepEqual(pickedColumn(data,geometry.faceColumns,0),{x:-2,z:3,blockX:-32,blockZ:48});
});
test('empty columns and missing neighbors never become inferred slopes or floors',()=>{
  const data=tile();data.ids.fill(0);data.heights.fill(-32768);let geometry=surfaceGeometry(data);assert.equal(geometry.positions.length,0);
  data.ids[0]=1;data.heights[0]=80;geometry=surfaceGeometry(data,{west:{status:'unreadable'}});assert.equal(geometry.positions.length/9,2);assert.equal(geometry.grid.length,12);
  assert.throws(()=>surfaceGeometry({...data,status:'pending'}));assert.throws(()=>surfaceGeometry({...data,rgba:[]}));
});
test('known cross-chunk steps get a side; unreadable neighbor does not',()=>{
  const high=tile(),low=tile(-1,0);low.heights.fill(32);
  const withStep=surfaceGeometry(high,{west:low}),without=surfaceGeometry(high,{west:{status:'unreadable'}});
  assert.equal(withStep.positions.length/9-without.positions.length/9,32);
  assert.equal(Math.min(...withStep.positions.filter((_,i)=>i%3===1)),33);
  assert.ok(TOPO_TRIANGLE_LIMIT>=TOPO_CHUNK_LIMIT*(256*10+2));
});
test('ray picking uses actual surface faces and exact owning column at negative coordinates',()=>{
  const data=tile(-2,-1);data.heights[8*16+8]=100;const geometry=surfaceGeometry(data),buffer=new THREE.BufferGeometry();
  buffer.setAttribute('position',new THREE.BufferAttribute(geometry.positions,3));
  const mesh=new THREE.Mesh(buffer,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
  const ray=new THREE.Raycaster(new THREE.Vector3(8.5,200,8.5),new THREE.Vector3(0,-1,0)),hit=ray.intersectObject(mesh)[0];
  assert.equal(hit.point.y,101);assert.deepEqual(pickedColumn(data,geometry.faceColumns,hit.faceIndex),{x:-2,z:-1,blockX:-24,blockZ:-8});
  data.ids[8*16+8]=0;const empty=surfaceGeometry(data);buffer.setAttribute('position',new THREE.BufferAttribute(empty.positions,3));buffer.computeBoundingSphere();
  assert.equal(ray.intersectObject(mesh).length,0);buffer.dispose();mesh.material.dispose();
});
