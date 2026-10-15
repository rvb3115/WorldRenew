// Isolated native cache acceptance/benchmark. Never uses the regular profile.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {_electron as electron} from 'playwright';
import {makeTerrainWorld} from '../tests/terrain-fixtures.js';import {inventory,hashFile} from '../engine/safety.js';import {safePath} from '../engine/paths.js';import {inspectWorld} from '../engine/world.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/cache-smoke-')),profile=path.join(work,'profile'),copy=path.join(work,'world-copy');
const source=process.argv[2]?fs.realpathSync(process.argv[2]):makeTerrainWorld(path.join(work,'generated-source'));
const before=inventory(source),hashes=before.files.map(f=>({path:f.path,hash:hashFile(safePath(source,f.path))}));assert.ok(before.files.reduce((n,f)=>n+f.bytes,0)<512*1024**2);
fs.cpSync(source,copy,{recursive:true,errorOnExist:true,force:false});
function verify(){assert.deepEqual(inventory(source),before);for(const f of hashes){assert.equal(hashFile(safePath(source,f.path)),f.hash);assert.equal(hashFile(safePath(copy,f.path)),f.hash);}}
verify();const report=inspectWorld(copy),ow=report.dimensions.find(d=>d.id==='minecraft:overworld'),nether=report.dimensions.find(d=>d.id==='minecraft:the_nether');
const env={...process.env,WORLDRENEW_BACKGROUND_TEST:'1',WORLDRENEW_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,errors=[];let app,page,peakRssKiB=0,peakRendererHeap=0,timer;
async function launch(){
 app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--world=${copy}`],env,timeout:30000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 timer=setInterval(async()=>{try{const rss=await app.evaluate(({app})=>app.getAppMetrics().reduce((n,p)=>n+(p.memory?.workingSetSize??0),0));peakRssKiB=Math.max(peakRssKiB,rss);peakRendererHeap=Math.max(peakRendererHeap,await page.evaluate(()=>performance.memory.usedJSHeapSize));}catch{}},500);
}
async function close(){clearInterval(timer);await app.close();}
const state=()=>page.locator('#terrain-status').evaluate(el=>({...el.dataset}));
const complete=()=>page.waitForFunction(()=>{const d=document.getElementById('terrain-status').dataset;return d.overviewPending==='0'&&d.validating==='0';},null,{timeout:180000});
async function opening(){const start=Date.now();await page.click('#open');await page.waitForFunction(()=>Number(document.getElementById('terrain-status').dataset.overviewReady)>0,null,{timeout:60000});const firstUsefulMs=Date.now()-start;await complete();return {firstUsefulMs,completeMs:Date.now()-start,state:await state()};}
try{
 await launch();const cold=await opening();assert.equal(Number(cold.state.total),ow.chunkCount);assert.ok(Number(cold.state.overviewReady)>0);
 await page.screenshot({path:path.join(work,'cold-complete.png')});
 // Keep selection and non-default 2D view across dimension changes.
 await page.click('#select-all');await page.click('#zoom-in');const view=await page.locator('#map').evaluate(el=>({...el.dataset}));
 const switched=Date.now();await page.selectOption('#dimension',nether.key);await complete();const netherState=await state();
 await page.selectOption('#dimension',ow.key);await complete();const returned=await state(),returnMs=Date.now()-switched;
 assert.equal(await page.textContent('#selection-count'),ow.chunkCount.toLocaleString());assert.deepEqual(await page.locator('#map').evaluate(el=>({...el.dataset})),view);
 assert.equal(returned.overviewReady,cold.state.overviewReady);assert.equal(returned.overviewIncomplete,cold.state.overviewIncomplete);
 // Switch with outstanding reads, then repeatedly return to the same state object.
 await page.selectOption('#dimension',nether.key);await page.selectOption('#terrain-mode','roof');await page.selectOption('#dimension',ow.key);
 for(let i=0;i<5;i++){await page.selectOption('#dimension',nether.key);await page.selectOption('#dimension',ow.key);}
 await complete();assert.equal((await state()).overviewReady,cold.state.overviewReady);
 // Same coordinate in distinct dimensions must never borrow a surface.
 if(nether.chunkCount){
   const tiles=await page.evaluate(async keys=>{const opened=await window.worldrenew.rescan(),session=opened.result.terrainSession;const out=[];for(const dimension of keys){const r=await window.worldrenew.terrainTiles({session,dimension,chunks:[{x:0,z:0}]});out.push(r.result.tiles[0]);}return out;},[ow.key,nether.key]);
   assert.notDeepEqual(tiles[0].heights,tiles[1].heights);
   // Direct IPC rescan was a controlled inspection; reload renderer with the normal Refresh action.
   await page.click('#rescan');await complete();
 }
 // 3D camera restored independently of 2D view and another dimension's camera.
 await page.selectOption('#map-view','topographic');await page.waitForFunction(()=>document.getElementById('terrain-status').dataset.pending==='0',null,{timeout:60000});
 await page.focus('#topographic-map');await page.keyboard.press('q');await page.click('#zoom-out');
 await page.waitForTimeout(100);const topo=await page.locator('#topographic-map').evaluate(el=>({x:el.dataset.centerX,z:el.dataset.centerZ,d:el.dataset.distance,yaw:el.dataset.yaw}));
 await page.selectOption('#dimension',nether.key);await page.selectOption('#dimension',ow.key);await page.waitForTimeout(100);
 assert.deepEqual(await page.locator('#topographic-map').evaluate(el=>({x:el.dataset.centerX,z:el.dataset.centerZ,d:el.dataset.distance,yaw:el.dataset.yaw})),topo);
 await page.selectOption('#map-view','topdown');await page.click('#fit');await complete();await close();
 await launch();const warm=await opening();assert.equal(warm.state.overviewReady,cold.state.overviewReady);assert.equal(warm.state.overviewIncomplete,cold.state.overviewIncomplete);assert.ok(Number(warm.state.diskHits)>=ow.chunkCount);
 if(ow.chunkCount>1024)assert.equal(Number(warm.state.decoded),0,'Warm whole overview uses cache without terrain decoding.');
 await page.screenshot({path:path.join(work,'warm-reopen.png')});await close();verify();assert.deepEqual(errors,[]);
 const cacheFiles=fs.readdirSync(path.join(profile,'terrain-cache')).filter(f=>f.endsWith('.json')),cacheBytes=cacheFiles.reduce((n,f)=>n+fs.statSync(path.join(profile,'terrain-cache',f)).size,0);
 const result={passed:true,world:process.argv[2]?'approved disposable snapshot':'generated terrain fixture',source,copy,profile,chunks:ow.chunkCount,regions:ow.regions.length,cold,warm,dimensionReturnMs:returnMs,netherState,peakRssKiB,peakRendererHeap,cacheBytes,cacheFiles:cacheFiles.length,filesVerified:hashes.length,unchanged:true,backgroundSession:true,executable:executablePath??'development',screenshots:work};
 fs.writeFileSync(path.join(work,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}catch(error){try{console.error(await page.locator('#terrain-status').textContent());await page.screenshot({path:path.join(work,'failure.png')});await close();}catch{}throw error;}
