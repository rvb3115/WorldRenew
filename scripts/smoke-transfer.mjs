import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeBlockWorld, writeBlockChunk, buildBlock, state } from '../tests/transfer-fixtures.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=fs.mkdtempSync(path.join(root,'work/transfer-smoke-'));
const source=makeBlockWorld(path.join(work,'source'),{block:buildBlock});
writeBlockChunk(path.join(source,'dimensions/minecraft/the_nether/region/r.0.0.mca'),{sections:Array.from({length:16},(_,i)=>i),block:(x,y,z)=>state(y===127?'bedrock':y===128?'obsidian':x===7&&z===7&&y>=129&&y<=131?'nether_portal':'air')});
const destination=makeBlockWorld(path.join(work,'destination'),{block:()=>state('stone')});
writeBlockChunk(path.join(destination,'dimensions/minecraft/the_nether/region/r.0.0.mca'),{sections:Array.from({length:16},(_,i)=>i),block:()=>state('air')});
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>{const f=path.join(d.parentPath,d.name);return [f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')];}));
const before={...hashes(source),...hashes(destination)};
const env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'app-data')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE;
const app=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[root]),`--world=${source}`],env,timeout:30000});
const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning'&&m.text().includes('THREE.Color'))errors.push(m.text());});
 await page.click('#open');await page.waitForFunction(()=>document.getElementById('world-name').textContent.includes('Build transfer'));
 await page.click('#open-transfer');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Read '));
 assert.equal(await page.isVisible('#source-pane'),true);assert.equal(await page.isVisible('#destination-pane'),false);
 await page.click('#selection-coordinates > summary');
 // Load the full synthetic underground/above-ground/sky test volume.
 for(const [k,v] of Object.entries({minX:0,maxX:15,minY:-16,maxY:31,minZ:0,maxZ:15}))await page.fill(`#build-${k}`,String(v));
 await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));
 await page.waitForFunction(()=>Number(document.getElementById('build-3d').dataset.faceCount)>0);
 assert.equal(await page.inputValue('#build-view-mode'),'spectator');
 const camera=await page.textContent('#build-camera');await page.focus('#build-3d');await page.keyboard.down('KeyE');await page.waitForTimeout(250);await page.keyboard.up('KeyE');assert.notEqual(await page.textContent('#build-camera'),camera);
 await page.click('#build-view-tools > summary');
 // Jump directly into the enclosed underground room, proving collision does not constrain the camera.
 for(const [k,v]of Object.entries({x:7,y:-3,z:7}))await page.fill(`#camera-${k}`,String(v));await page.click('#camera-go');await page.waitForFunction(()=>document.getElementById('build-camera').textContent.includes('7.0, -3.0, 7.0'));
 // Read-only browsing uses a separate IPC path, preserving the captured selection.
 const selectedBefore=await page.locator('#build-bounds input').evaluateAll(inputs=>inputs.map(i=>i.value));
 await page.selectOption('#camera-speed','4');await page.click('#build-near-camera');
 await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Nearby terrain loaded.')&&!document.getElementById('build-capture').disabled);
 assert.deepEqual(await page.locator('#build-bounds input').evaluateAll(inputs=>inputs.map(i=>i.value)),selectedBefore);
 assert.equal(await page.isDisabled('#build-selection-save'),false);
 assert.ok((await page.textContent('#build-camera')).includes('7.0, -3.0, 7.0'));
 const retained=await page.evaluate(()=>window.worldrenew.saveSelection('Selection retained after browsing'));
 assert.equal(retained.error,undefined);assert.deepEqual(retained.result.entry.bounds,{minX:0,maxX:15,minY:-16,maxY:31,minZ:0,maxZ:15});
 await page.locator('#build-3d').scrollIntoViewIfNeeded();const box=await page.locator('#build-3d').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.waitForFunction(()=>document.getElementById('build-hover').textContent.startsWith('Block '));
 await page.selectOption('#build-pick','first');await page.mouse.click(box.x+box.width/2,box.y+box.height/2);assert.equal(await page.inputValue('#build-pick'),'second');
 // Restore a known whole build, save it, and verify reload preserves the bounds.
 for(const[k,v]of Object.entries({minX:0,maxX:15,minY:-16,maxY:31,minZ:0,maxZ:15}))await page.fill(`#build-${k}`,String(v));await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));
 await page.click('#selection-library > summary');
 await page.fill('#build-selection-name','House, basement and sky platform');await page.click('#build-selection-save');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Saved “'));
 const saved=await page.locator('#build-library option').nth(1).getAttribute('value');await page.selectOption('#build-library',saved);await page.fill('#build-minY','0');await page.click('#build-selection-load');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('block content matches'));assert.equal(await page.inputValue('#build-minY'),'-16');
 await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},destination);
 await page.click('#next-placement');assert.equal(await page.isVisible('#source-pane'),false);
 await page.click('#build-open-destination');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Destination opened'));
 for(const[k,v]of Object.entries({x:0,y:-16,z:0}))await page.fill(`#build-anchor-${k}`,String(v));await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));
 assert.ok((await page.textContent('#build-findings')).includes('destination blocks would become source air'));
 await page.click('#build-save');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Preview report saved'));
 await page.selectOption('#build-layer','proposed');await page.click('#build-fit');await page.screenshot({path:path.join(work,'3d-placement.png')});
 // Destination picking and one-block adjustment.
 await page.click('#build-view-destination');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Click a destination')&&!document.getElementById('build-pick').disabled);
 await page.locator('#build-3d').scrollIntoViewIfNeeded();const destBox=await page.locator('#build-3d').boundingBox();await page.mouse.click(destBox.x+destBox.width/2,destBox.y+destBox.height/2);await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement corner:'));
 const x=Number(await page.inputValue('#build-anchor-x'));await page.click('[data-axis="x"][data-step="1"]');assert.equal(Number(await page.inputValue('#build-anchor-x')),x+1);assert.equal(await page.isDisabled('#build-save'),true);
 await page.click('#step-source');
 const nether=await page.locator('#build-source-dimension option').evaluateAll(opts=>opts.find(o=>o.textContent==='the nether').value);
 await page.selectOption('#build-source-dimension',nether);await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));await page.selectOption('#build-height','roof');assert.equal(await page.inputValue('#build-minY'),'128');assert.equal(await page.inputValue('#build-maxY'),'255');await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));
 await page.click('#step-destination');
 await page.selectOption('#build-destination-dimension',nether);for(const[k,v]of Object.entries({x:0,y:128,z:0}))await page.fill(`#build-anchor-${k}`,String(v));await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));assert.ok((await page.textContent('#build-findings')).includes('active Nether portal blocks'));assert.ok((await page.textContent('#build-findings')).includes('matching overworld network'));
 await page.click('#step-source');
 await page.selectOption('#build-layer','source');await page.locator('.build-controls').evaluate(el=>el.scrollTop=0);await page.locator('#build-y').fill('136');await page.locator('#build-y').dispatchEvent('input');await page.click('#build-fit');await page.screenshot({path:path.join(work,'nether-roof.png')});
 // Failed rescans cannot retain a saveable old selection or an old placement label.
 await page.fill('#build-maxY','1');await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').classList.contains('error'));assert.equal(await page.isDisabled('#build-selection-save'),true);assert.equal(await page.isDisabled('#build-save'),true);assert.equal(await page.inputValue('#build-layer'),'source');
 assert.deepEqual({...hashes(source),...hashes(destination)},before);assert.deepEqual(errors,[]);
 console.log(`PASS: 3D mesh, no-clip camera, block picking, external selection library/reload, destination pick/nudge, conflict preview/report, dimensions, Nether roof/portal warnings, unchanged saves.\nScreenshots: ${work}`);
}finally{await app.close();}
