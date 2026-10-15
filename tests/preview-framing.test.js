import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {blockPreviewFrame,matchingPreview,matchingPreviewRequest,previewLimitMessage,previewLocationText} from '../ui/preview-framing.js';
import {Spectator} from '../ui/spectator.js';
import {TopographicMap} from '../ui/topographic-map.js';
import {selectionExtent} from '../ui/map-selection.js';
const bounds={minX:-48,maxX:-33,minY:-64,maxY:319,minZ:32,maxZ:47};
test('absolute negative-coordinate frames contain every requested corner across narrow and wide viewports',()=>{
  for(const aspect of [.35,1,2.5]){
    const frame=blockPreviewFrame(bounds,{aspect}),camera=new THREE.PerspectiveCamera(65,aspect,.02,10000);
    assert.deepEqual(frame.center,{x:-40,y:128,z:40});camera.position.set(...['x','y','z'].map(k=>frame.position[k]));camera.lookAt(frame.center.x,frame.center.y,frame.center.z);camera.updateMatrixWorld();
    for(const x of [bounds.minX,bounds.maxX+1])for(const y of [bounds.minY,bounds.maxY+1])for(const z of [bounds.minZ,bounds.maxZ+1]){
      const p=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(p.x)<1&&Math.abs(p.y)<1&&p.z>-1&&p.z<1);
    }
  }
});
test('spectator explicit framing ignores old camera and asymmetric known-geometry bounds',()=>{
  const fake={volume:{bounds},focusBounds:{minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1},camera:new THREE.PerspectiveCamera(65,1,.02,10000),canvas:{dataset:{}},resizeView(){}};
  fake.camera.position.set(9999,-1000,-9999);Spectator.prototype.fit.call(fake,bounds);
  assert.deepEqual(JSON.parse(fake.canvas.dataset.frameCenter),{x:-40,y:128,z:40});assert.deepEqual(JSON.parse(fake.canvas.dataset.frameBounds),bounds);
  const first=fake.camera.position.clone();fake.camera.position.set(-10,5,100);Spectator.prototype.fit.call(fake,bounds);assert.ok(fake.camera.position.equals(first));
});
test('explicit topographic selection framing resets remembered pose; ordinary restoration remains independent',()=>{
  let changes=0;const fake={selectionBounds:{minX:-3,maxX:-1,minZ:2,maxZ:4},canvas:{clientWidth:800,clientHeight:500},yaw:2.3,tilt:1.1,x:123456,z:-765432,distance:999999,changed(){changes++;}};
  TopographicMap.prototype.fitSelection.call(fake,{explicit:true});assert.equal(fake.x,-24);assert.equal(fake.z,56);assert.equal(fake.yaw,0);assert.equal(fake.tilt,.83);assert.ok(fake.distance<5000);assert.equal(changes,1);
  const saved={x:160,z:-32,y:70,distance:2000,yaw:1.4,tilt:.6};fake.syncScaleControl=()=>{};TopographicMap.prototype.restore.call(fake,saved);for(const[k,v]of Object.entries(saved))assert.equal(fake[k],v);
});
test('status annotations remain below terrain regardless of camera framing height',()=>{
  const fake={y:128,mark:()=>null};
  for(const status of ['ready','absent','pending','unreadable','unsupported']){
    const entry={tile:{status,x:0,z:0},marker:new THREE.Object3D(),border:new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial())};
    for(const y of [-64,128,320]){fake.y=y;TopographicMap.prototype.style.call(fake,entry);assert.equal(entry.marker.position.y,-66);assert.equal(entry.border.position.y,-65.9);}
  }
});
test('immutable preview identity detects world, layout/dimension and any changed bound',()=>{
  const request={root:'/generated/world-a',dimension:'minecraft:overworld|dimensions/minecraft/overworld',bounds};
  assert.equal(matchingPreview({...request},request),true);assert.equal(matchingPreviewRequest(structuredClone(request),request),true);
  for(const patch of [{root:'/generated/world-b'},{dimension:'minecraft:the_nether|DIM-1'},{dimension:'minecraft:overworld|.'},{bounds:{...bounds,minX:-47}}]){
    assert.equal(matchingPreview({...request,...patch},request),false);assert.equal(matchingPreviewRequest({...request,...patch},request),false);
  }
});
test('large disjoint selections retain exact bounds, disclose gaps and block dense volume substitution',()=>{
  const selection=new Set();for(let i=0;i<247895;i++)selection.add(`${i-100000},${i%100}`);
  const b=selectionExtent(selection);assert.deepEqual(b,{minX:-100000,maxX:147894,minZ:0,maxZ:99});
  const volume={minX:b.minX*16,maxX:b.maxX*16+15,minZ:b.minZ*16,maxZ:b.maxZ*16+15,minY:-64,maxY:319};
  assert.match(previewLimitMessage(volume),/No substitute area/);assert.match(previewLocationText('minecraft:overworld',volume),/unselected gaps/);
  assert.equal(previewLimitMessage(bounds),null);assert.throws(()=>previewLimitMessage({...bounds,minX:NaN}));
});
