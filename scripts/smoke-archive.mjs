import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {makeBlockWorld,state} from '../tests/transfer-fixtures.js';
import {placementWorld} from '../tests/placement-fixtures.js';
import {readBuildFile,sha} from '../engine/build-archive.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/archive-smoke-'));
const source=makeBlockWorld(path.join(work,'source'),{version:'26.2',dataVersion:4903,block:(x,y,z)=>state(y===0?'oak_planks':x===3&&z===3?'cave_air':'stone')}),destination=placementWorld(path.join(work,'destination')),file=path.join(work,'house.wrbuild');
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const f=path.join(e.parentPath,e.name);return[path.relative(dir,f),sha(fs.readFileSync(f))];}));
const before=hashes(destination),sourceBefore=hashes(source),env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'app-data')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,launch=()=>electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[root]),`--world=${source}`],env,timeout:30000});let app=await launch();const errors=[];
try{
 let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.click('#open');await page.waitForFunction(()=>!document.getElementById('open-transfer').disabled);await page.click('#open-transfer');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Read '));
 await page.click('#selection-coordinates > summary');for(const[k,v]of Object.entries({minX:2,maxX:5,minY:0,maxY:3,minZ:2,maxZ:5}))await page.fill(`#build-${k}`,String(v));await page.click('#build-capture');await page.waitForFunction(()=>!document.getElementById('build-archive-save').disabled);
 await app.evaluate(({dialog},f)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:f});},file);await page.click('#build-archive-save');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Portable build saved'));
 assert.equal(readBuildFile(file).volume.stats.total,64);assert.equal(await page.isDisabled('#build-minX'),true);assert.deepEqual(hashes(source),sourceBefore);await page.screenshot({path:path.join(work,'saved-build.png')});
 await app.close();fs.renameSync(source,source+'-offline');app=await launch();page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(({dialog},f)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]});},file);await page.click('#open-build-file');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Portable build loaded'));
 assert.equal(await page.textContent('#world-name'),'No world open');assert.equal(await page.isDisabled('#build-minX'),true);
 await app.evaluate(({dialog},f)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]});},destination);await page.click('#next-placement');await page.click('#build-open-destination');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Destination opened'));
 for(const[k,v]of Object.entries({x:20,y:2,z:20}))await page.fill(`#build-anchor-${k}`,String(v));await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));
 assert.ok((await page.textContent('#copy-eligibility')).startsWith('Ready for'));assert.equal(await page.isDisabled('#build-place-copy'),true);await page.check('#placement-closed');assert.equal(await page.isDisabled('#build-place-copy'),false);
 // Air policy is part of the reviewed operation, and changing it clears approval.
 const includedChanged=Number(await page.getAttribute('#air-effect-counts','data-changed'));
 assert.equal(Number(await page.getAttribute('#air-effect-counts','data-skipped')),0);
 await page.selectOption('#placement-air-mode','skip');
 assert.equal(await page.isDisabled('#build-place-copy'),true);assert.equal(await page.isChecked('#placement-closed'),false);
 await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));
 assert.ok(Number(await page.getAttribute('#air-effect-counts','data-skipped'))>0);
 assert.ok(Number(await page.getAttribute('#air-effect-counts','data-changed'))<includedChanged);
 await page.screenshot({path:path.join(work,'skip-air-review.png')});
 await page.selectOption('#placement-air-mode','include');
 assert.equal(await page.isDisabled('#build-place-copy'),true);assert.equal(await page.isChecked('#placement-closed'),false);
 await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));await page.check('#placement-closed');
 // Moving placement invalidates both review and the closed-world acknowledgment.
 await page.fill('#build-anchor-x','21');assert.equal(await page.isDisabled('#build-place-copy'),true);assert.equal(await page.isChecked('#placement-closed'),false);await page.fill('#build-anchor-x','20');await page.click('#build-preview');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Placement preview complete'));await page.check('#placement-closed');
 await page.screenshot({path:path.join(work,'review-placement.png')});await app.evaluate(({dialog},f)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]});},work);await page.click('#build-place-copy');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Test world copy created'),{timeout:30000});
 assert.ok((await page.getAttribute('#placement-result','title')).includes('Validation report:'));assert.deepEqual(hashes(destination),before);assert.deepEqual(hashes(source+'-offline'),sourceBefore);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(work,'created-copy.png')});
 console.log(`PASS: portable save, cold-start load without source, frozen bounds, air-mode counts and review invalidation, explicit closed-world acknowledgment, validated copied world, unchanged originals, no renderer errors.\nArtifacts: ${work}`);
}finally{await app.close();}
