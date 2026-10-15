// Isolated, hidden UI acceptance; accepts only this worktree's generated fixtures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import {inspectWorld} from '../engine/world.js';
import {isWithin} from '../engine/paths.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.argv.length,3,'Provide a generated benchmark fixture.');
const fixture=fs.realpathSync(process.argv[2]);assert.ok(isWithin(path.join(root,'work'),fixture));
const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'benchmark-fixture.json')));
assert.equal(manifest.generatedOnly,true);assert.equal(manifest.playable,false);
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=fs.readdirSync(fixture,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(e.parentPath,e.name);return {file,sha256:hash(file)};});
const report=inspectWorld(fixture),dimension=report.dimensions.find(d=>d.id==='minecraft:overworld');
const work=fs.mkdtempSync(path.join(root,'work/large-overview-ui-')),profile=path.join(work,'profile');
const env={...process.env,WORLDRENEW_BACKGROUND_TEST:'1',WORLDRENEW_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,errors=[];let app,page;
async function launch(){app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--world=${fixture}`],env,timeout:30000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.click('#open');await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Inspected'),null,{timeout:60000});}
const state=()=>page.locator('#terrain-status').evaluate(el=>({...el.dataset}));
async function settledPause(){let previous=-1,stable=0;for(let i=0;i<100;i++){await page.waitForTimeout(100);const current=Number((await state()).overviewPending);if(current===previous)stable++;else stable=0;if(stable===3)return current;previous=current;}throw new Error('Background overview did not pause at a batch boundary.');}
async function close(){await app.close();app=null;}
try{
  await launch();await page.waitForFunction(()=>Number(document.getElementById('terrain-status').dataset.overviewReady)>0,null,{timeout:60000});
  await page.click('#terrain-pause');const pending=await settledPause();assert.ok(pending>0,'Fixture must leave unfinished work for pause/resume.');
  assert.equal((await state()).paused,'true');await page.screenshot({path:path.join(work,'paused-overview.png')});
  const target=dimension.regions.at(-1).chunks.at(-1),started=performance.now();
  await page.fill('#map-x',String(target.x*16));await page.fill('#map-z',String(target.z*16));await page.click('#map-jump');
  await page.waitForFunction(()=>{const d=document.getElementById('terrain-status').dataset;return d.mode==='detail'&&d.pending==='0'&&Number(d.ready)>0;},null,{timeout:60000});
  const visibleDetailMs=performance.now()-started,detail=await state();assert.equal(detail.paused,'true');assert.ok(Number(detail.overviewPending)>0);
  await page.screenshot({path:path.join(work,'visible-detail-while-paused.png')});
  await page.click('#fit');const beforeClose=await state();await close();
  // Reopening reuses completed cache entries and continues remaining work.
  const reopened=performance.now();await launch();
  await page.waitForFunction(()=>Number(document.getElementById('terrain-status').dataset.diskHits)>0,null,{timeout:60000});
  const firstCached=await state();await page.waitForFunction(()=>{const d=document.getElementById('terrain-status').dataset;return d.overviewPending==='0'&&d.validating==='0';},null,{timeout:600000});
  const complete=await state(),resumeCompleteMs=performance.now()-reopened;
  assert.equal(Number(complete.overviewReady),manifest.chunks);assert.ok(Number(complete.diskHits)>=Number(beforeClose.overviewReady));
  assert.ok(Number(complete.decoded)<manifest.chunks,'Previously cached chunks must not be decoded again.');
  await page.screenshot({path:path.join(work,'resumed-complete.png')});await close();
  await launch();await page.waitForFunction(()=>{const d=document.getElementById('terrain-status').dataset;return d.overviewPending==='0'&&d.validating==='0';},null,{timeout:60000});
  const warm=await state();assert.equal(Number(warm.decoded),0);assert.equal(Number(warm.overviewReady),manifest.chunks);await close();
  for(const item of hashes)assert.equal(hash(item.file),item.sha256);assert.deepEqual(errors,[]);
  const evidence={passed:true,version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,fixture,generatedOnly:true,originalWorldsUsed:false,installedAppModified:false,backgroundSession:true,chunks:manifest.chunks,regions:manifest.regions,pendingWhenPaused:pending,visibleDetailMs,detail,beforeClose,firstCached,resumeCompleteMs,complete,warm,filesUnchanged:hashes.length,screenshots:work};
  fs.writeFileSync(path.join(work,'results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){if(page){try{console.error(await page.locator('#terrain-status').textContent());await page.screenshot({path:path.join(work,'failure.png')});}catch{}}throw error;}finally{if(app)await close();}
