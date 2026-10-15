import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {applyChunkRange,selectionExtent} from '../ui/map-selection.js';
import {REFERENCE_DISTANCE,distanceForSlider,sliderForDistance,fitSelectionDistance} from '../ui/view-scale.js';
import {overviewColor} from '../ui/terrain-overview.js';
test('range selection supports add/remove and disconnected offscreen chunks without filling absent cells',()=>{
  const chunks=[{x:-10,z:-1},{x:-9,z:-1},{x:100,z:200},{x:500,z:500}],original=new Set(['100,200']);
  const added=applyChunkRange(original,chunks,{x:-9,z:-1},{x:-10,z:-1},'add');assert.deepEqual([...added],['100,200','-10,-1','-9,-1']);assert.deepEqual([...original],['100,200']);
  const removed=applyChunkRange(added,chunks,{x:-10,z:-1},{x:-10,z:-1},'remove');assert.deepEqual([...removed],['100,200','-9,-1']);
  assert.deepEqual(selectionExtent(removed),{minX:-9,maxX:100,minZ:-1,maxZ:200});
  assert.deepEqual([...applyChunkRange(removed,chunks,{x:500,z:500},{x:500,z:500})],['500,500']);
  assert.throws(()=>applyChunkRange(removed,chunks,{x:NaN,z:0},{x:0,z:0}));
});
test('large selections iterate existing index, retain more than the terrain/export limits and never allocate the whole rectangle',()=>{
  const chunks=Array.from({length:100001},(_,i)=>({x:i-50000,z:i%7}));
  const result=applyChunkRange(new Set(),chunks,{x:-Number.MAX_SAFE_INTEGER,z:-1},{x:Number.MAX_SAFE_INTEGER,z:9});
  assert.equal(result.size,chunks.length);assert.equal(selectionExtent(result).minX,-50000);
});
test('view scale has a fixed largest default, smaller ratios and reversible camera-only values',()=>{
  assert.equal(distanceForSlider(20),REFERENCE_DISTANCE);assert.equal(distanceForSlider(19),REFERENCE_DISTANCE*2);
  for(const value of [0,3.5,19,20])assert.ok(Math.abs(sliderForDistance(distanceForSlider(value))-value)<1e-9);
  assert.equal(distanceForSlider(30),REFERENCE_DISTANCE);
});
test('fit selection includes broad disconnected extents and height in portrait/landscape cameras',()=>{
  for(const bounds of [{minX:-30,maxX:30,minZ:-40,maxZ:40},{minX:-1875000,maxX:1874999,minZ:-1875000,maxZ:1874999}])for(const aspect of [.5,2])for(const yaw of [-.4,1.2]){
    const tilt=.83,d=fitSelectionDistance(bounds,{aspect,yaw,tilt}),camera=new THREE.PerspectiveCamera(45,aspect,.1,d*4);
    camera.position.set(d*Math.sin(tilt)*Math.sin(yaw),d*Math.cos(tilt),d*Math.sin(tilt)*Math.cos(yaw));camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const hx=(bounds.maxX-bounds.minX+1)*8,hz=(bounds.maxZ-bounds.minZ+1)*8;
    for(const x of [-hx,hx])for(const y of [-192,192])for(const z of [-hz,hz]){const p=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(p.x)<1&&Math.abs(p.y)<1,JSON.stringify({p,d,bounds}));}
  }
});
test('coarse terrain colors use decoded columns, keep errors distinct, and do not interpret unknown as air',()=>{
  const tile={status:'ready',ids:new Uint16Array(256).fill(1),rgba:new Uint8Array(1024)};for(let i=0;i<256;i++)tile.rgba.set([20,100,200,255],i*4);
  assert.equal(overviewColor(tile),'#1464c8');assert.notEqual(overviewColor({status:'unreadable'}),overviewColor({status:'absent'}));
  tile.ids.fill(0);assert.equal(overviewColor(tile),'#35515e');assert.notEqual(overviewColor(tile),overviewColor({status:'unreadable'}));
});
