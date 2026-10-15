import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {makeBlockWorld,state} from '../tests/transfer-fixtures.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/model-smoke-'));
const blocks=[state('oak_stairs',{facing:'east',half:'bottom',shape:'straight',waterlogged:'false'}),state('oak_stairs',{facing:'south',half:'bottom',shape:'inner_left',waterlogged:'false'}),state('oak_slab',{type:'bottom',waterlogged:'false'}),state('oak_slab',{type:'top',waterlogged:'false'}),state('oak_fence',{north:'true',south:'true',east:'true',west:'false',waterlogged:'false'}),state('oak_door',{facing:'east',half:'lower',hinge:'left',open:'false',powered:'false'}),state('glass'),state('red_stained_glass'),state('short_grass')];
const world=makeBlockWorld(path.join(work,'world'),{block:(x,y,z)=>{
 if(y===0)return state('stone');
 if(y===1&&x%4===2&&z%4===2&&x<12&&z<12)return blocks[Math.floor(z/4)*3+Math.floor(x/4)];
 return state('air');
}});
const hashes=()=>Object.fromEntries(fs.readdirSync(world,{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>{const f=path.join(d.parentPath,d.name);return[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')];})),before=hashes();
const env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'app-data')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,app=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[root]),`--world=${world}`],env,timeout:30000});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.click('#open');await page.waitForFunction(()=>!document.getElementById('open-transfer').disabled);await page.click('#open-transfer');
 await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Read '));
 await page.click('#selection-coordinates > summary');
 for(const[k,v]of Object.entries({minX:0,maxX:12,minY:0,maxY:3,minZ:0,maxZ:12}))await page.fill(`#build-${k}`,String(v));
 await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete')&&!document.getElementById('build-capture').disabled);
 assert.ok(Number(await page.locator('#build-3d').getAttribute('data-model-count'))>=10,'Installed Minecraft models required for this opt-in smoke test.');
 await page.click('#selection-coordinates > summary');await page.click('#build-fit');await page.screenshot({path:path.join(work,'block-models.png')});
 const report=await page.evaluate(async()=>{
   const palette=[null,{Name:'minecraft:stone'},{Name:'minecraft:oak_slab',Properties:{type:'bottom',waterlogged:'false'}},{Name:'minecraft:red_stained_glass'}];
   const response=await window.worldrenew.loadTextures({palette,version:'26.2'});if(response.error)throw Error(response.error.message);
   const {Spectator}=await import('./spectator.js'),canvas=document.createElement('canvas');canvas.style.cssText='position:fixed;top:0;left:0;width:640px;height:360px';document.body.append(canvas);
   let picked=null;const s=new Spectator(canvas,{color:()=> '#aaa',onCamera:()=>{},onHover:()=>{},onPick:p=>picked=p,onError:e=>{throw Error(e);}});await s.setTextures(response.result,palette);
   const v={palette,voxels:new Uint32Array([1,2]),size:{x:2,y:1,z:1},bounds:{minX:0,maxX:1,minY:0,maxY:0,minZ:0,maxZ:0}};s.setVolume(v);s.resizeView();
   const positions=s.mesh.geometry.attributes.position.array,owners=s.mesh.userData.owners;let slabMaxY=0,stoneEast=0;
   owners.forEach((owner,i)=>{const a=Array.from(positions.slice(i*18,i*18+18));if(owner===1)slabMaxY=Math.max(slabMaxY,...a.filter((_,j)=>j%3===1));if(owner===0&&a.filter((_,j)=>j%3===0).every(n=>n===1))stoneEast++;});
   const click=y=>{picked=null;s.camera.position.set(1.75,y,2);s.camera.lookAt(1.75,y,0);s.scene.updateMatrixWorld(true);const r=canvas.getBoundingClientRect();s.pick({clientX:r.left+r.width/2,clientY:r.top+r.height/2},true);return picked;};
   const gap=click(.75),slab=click(.25);
   s.setVolume({...v,voxels:new Uint32Array([3,1])});const transparent=s.transparentMesh.geometry.attributes.position.count>0&&!s.transparentMesh.material.depthWrite;
   s.clear();s.resize.disconnect();s.renderer.dispose();s.textures.texture.dispose();canvas.remove();return {slabMaxY,stoneEast,gap,slab,transparent};
 });
 assert.equal(report.slabMaxY,.5);assert.equal(report.stoneEast,1,'Opaque neighbor face must remain visible beside a partial slab.');assert.equal(report.gap,null,'Picking must pass through the empty upper half of a slab.');assert.equal(report.slab.x,1);assert.equal(report.slab.state.Name,'minecraft:oak_slab');assert.equal(report.transparent,true);
 assert.deepEqual(hashes(),before);assert.deepEqual(errors,[]);
 console.log(`PASS: real installed block models, partial geometry/culling, ray picking through slab gaps, translucent glass, unchanged save.\nScreenshots: ${work}`);
}finally{await app.close();}
