// Read-only real-save acceptance test. The app sees only a byte-verified disposable copy.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {_electron as electron} from 'playwright';
import {inventory,hashFile} from '../engine/safety.js';import {canonicalWorld,safePath,isWithin} from '../engine/paths.js';import {inspectWorld} from '../engine/world.js';import {TOPO_CHUNK_LIMIT,TOPO_TRIANGLE_LIMIT} from '../ui/topography-geometry.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.argv.length,3,'Provide an existing world for a disposable-copy test.');const source=canonicalWorld(process.argv[2]);assert.ok(!isWithin(source,root));
const work=fs.mkdtempSync(path.join(root,'work/overview-smoke-')),copy=path.join(work,'world-copy'),profile=path.join(work,'profile');
const before=inventory(source),bytes=before.files.reduce((n,f)=>n+f.bytes,0);assert.ok(bytes<=512*1024**2);
const hashes=before.files.map(f=>({path:f.path,sha256:hashFile(safePath(source,f.path))}));fs.mkdirSync(copy);
for(const dir of before.directories)fs.mkdirSync(path.join(copy,dir),{recursive:true});for(const file of before.files)fs.copyFileSync(safePath(source,file.path),path.join(copy,file.path),fs.constants.COPYFILE_EXCL);
function verify(){assert.deepEqual(inventory(source),before);for(const f of hashes){assert.equal(hashFile(safePath(source,f.path)),f.sha256);assert.equal(hashFile(safePath(copy,f.path)),f.sha256);}assert.deepEqual(inventory(source),before);}
verify();const world=inspectWorld(copy),overworld=world.dimensions.find(d=>d.id==='minecraft:overworld'),chunks=overworld.regions.flatMap(r=>r.chunks);assert.ok(chunks.length>1024);
const env={...process.env,WORLDRENEW_BACKGROUND_TEST:'1',WORLDRENEW_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE;const app=await electron.launch({...executablePath?{executablePath}:{},args:executablePath?[]:[root],env,timeout:30000});
try{
  // Observe the actual Electron chooser call without displaying a dialog over the user's session.
  await app.evaluate(({dialog},copy)=>{global.chooserOptions=[];dialog.showOpenDialog=async(_window,options)=>{global.chooserOptions.push(options);return global.chooserOptions.length===1?{canceled:false,filePaths:[copy]}:{canceled:true,filePaths:[]};};},copy);
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Renderer error:',e.message);});const started=Date.now();await page.click('#open');
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Inspected'),null,{timeout:60000});
  await page.waitForFunction(()=>document.getElementById('terrain-status').dataset.mode==='overview'&&Number(document.getElementById('terrain-status').dataset.ready)>0,null,{timeout:60000});
  const firstColorMs=Date.now()-started;
  await page.waitForFunction(()=>document.getElementById('terrain-status').dataset.pending==='0',null,{timeout:180000});
  const overview=await page.locator('#terrain-status').evaluate(el=>({...el.dataset}));assert.equal(Number(overview.total),chunks.length);assert.equal(Number(overview.ready)+Number(overview.failed),Number(overview.sampled));assert.ok(Number(overview.ready)>1024);assert.ok(Number(overview.failed)>=Number(overview.incomplete));
  const fullOverviewMs=Date.now()-started;await page.screenshot({path:path.join(work,'automatic-topdown.png')});
  await page.click('#fit');await page.waitForFunction(()=>document.getElementById('terrain-status').dataset.mode==='overview'&&document.getElementById('terrain-status').dataset.pending==='0');
  await page.click('#select-all');assert.equal(await page.textContent('#selection-count'),chunks.length.toLocaleString());
  await page.selectOption('#map-view','topographic');
  const settle=async()=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.waitForFunction(()=>document.getElementById('topographic-map').dataset.building==='0'&&document.getElementById('terrain-status').dataset.pending==='0',null,{timeout:60000});};
  await settle();await page.click('#fit-selection');await settle();
  const all=await page.locator('#topographic-map').evaluate(el=>({...el.dataset}));assert.equal(Number(all.selectedTotal),chunks.length);assert.ok(Number(all.selectedOutside)>0);assert.ok(Number(all.meshes)<=TOPO_CHUNK_LIMIT);assert.ok(Number(all.triangles)<=TOPO_TRIANGLE_LIMIT);
  await page.screenshot({path:path.join(work,'all-chunks-fit.png')});
  await page.click('#view-scale-reset');await page.focus('#view-scale');for(let i=0;i<10;i++)await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>Math.abs(Number(document.getElementById('topographic-map').dataset.viewScale)-.5)<.001);
  assert.equal(await page.textContent('#selection-count'),chunks.length.toLocaleString());
  await page.fill('#map-x',String(chunks[0].x*16));await page.fill('#map-z',String(chunks[0].z*16));await page.click('#map-jump');await settle();
  assert.equal(await page.textContent('#selection-count'),chunks.length.toLocaleString());
  await page.click('#open-transfer');assert.equal(Number(await page.inputValue('#build-minX')),Math.min(...chunks.map(c=>c.x))*16);assert.equal(Number(await page.inputValue('#build-maxX')),Math.max(...chunks.map(c=>c.x))*16+15);await page.click('#close-build');
  await page.click('#clear-map-selection');await page.click('#select-range');await page.selectOption('#selection-mode','add');
  for(const c of [chunks[0],chunks.at(-1)]){for(const [id,value]of Object.entries({x1:c.x,x2:c.x,z1:c.z,z2:c.z}))await page.fill('#'+id,String(value));await page.click('#select-area');}
  assert.equal(await page.textContent('#selection-count'),'2');await page.selectOption('#selection-mode','remove');await page.click('#select-area');assert.equal(await page.textContent('#selection-count'),'1');
  await page.selectOption('#dimension',{label:'The Nether · 0 chunks'});await page.selectOption('#dimension',overworld.key);assert.equal(await page.textContent('#selection-count'),'1');
  await page.click('#toggle-protection');await page.selectOption('#map-view','topdown');await page.click('#fit');
  await page.waitForFunction(()=>document.getElementById('terrain-status').dataset.mode==='overview'&&document.getElementById('terrain-status').dataset.pending==='0',null,{timeout:60000});
  await page.click('#open');const chooser=await app.evaluate(()=>global.chooserOptions);assert.equal(chooser[0].properties[0],'openDirectory');assert.match(chooser[0].defaultPath,/minecraft[/\\]saves$/);assert.equal(chooser[1].defaultPath,copy);
  assert.deepEqual(errors,[]);verify();
  const report={passed:true,source,copy,profile,version:world.metadata.version,chunks:chunks.length,filesVerified:hashes.length,sourceAndCopyUnchanged:true,firstColorMs,fullOverviewMs,overview,topographic:all,chooser:{defaultPath:chooser[0].defaultPath,rememberedPath:chooser[1].defaultPath,nativeOptionsObserved:true,visibleSystemDialogOpened:false},backgroundSession:true,executable:executablePath??'development',checks:['automatic initial overview without wheel/pan','Fit world auto loads','view-switch cache reuse','all indexed chunks selected beyond display window','camera-only slider preserves selection','offscreen transfer bounds intact','add/remove disconnected ranges','dimension selection retained','native chooser defaults and remembered path'],screenshots:work};
  fs.writeFileSync(path.join(work,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){const page=await app.firstWindow();console.error(JSON.stringify(await page.evaluate(()=>({status:document.getElementById('status').textContent,terrain:document.getElementById('terrain-status').textContent,data:{...document.getElementById('terrain-status').dataset}})),null,2));await page.screenshot({path:path.join(work,'failure.png')});throw error;}finally{await app.close();}
