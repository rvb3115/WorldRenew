// Large indexed-world UI check with a verified generated cache, not a cold-scan benchmark.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {_electron as electron} from 'playwright';import {createHash} from 'node:crypto';import {isWithin} from '../engine/paths.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');assert.equal(process.argv.length,4);
const fixture=fs.realpathSync(process.argv[2]),cache=fs.realpathSync(process.argv[3]);assert.ok(isWithin(path.join(root,'work'),fixture)&&isWithin(path.join(root,'work'),cache));
const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'benchmark-fixture.json')));assert.equal(manifest.generatedOnly,true);assert.equal(manifest.playable,false);
const work=fs.mkdtempSync(path.join(root,'work/overview-scale-ui-')),profile=path.join(work,'profile');fs.mkdirSync(profile);fs.cpSync(cache,path.join(profile,'terrain-cache'),{recursive:true});
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),files=fs.readdirSync(fixture,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const p=path.join(e.parentPath,e.name);return {path:p,sha256:hash(p)};});
const env={...process.env,WORLDRENEW_BACKGROUND_TEST:'1',WORLDRENEW_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--world=${fixture}`],env,timeout:30000});let page;
try{
 page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));const start=performance.now();await page.click('#open');
 await page.waitForFunction(()=>{const d=document.getElementById('terrain-status').dataset;return d.overviewPending==='0'&&d.validating==='0';},null,{timeout:120000});
 const openAndValidateMs=performance.now()-start,state=await page.locator('#terrain-status').evaluate(e=>({...e.dataset}));
 assert.equal(Number(state.total),manifest.chunks);assert.equal(Number(state.overviewReady),manifest.chunks);assert.equal(Number(state.decoded),0);assert.equal(state.phase,'complete');
 const memory=await app.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,memory:p.memory})));await page.screenshot({path:path.join(work,'large-cached-overview.png')});assert.deepEqual(errors,[]);
 const result={passed:true,generatedOnly:true,fixture,chunkCount:manifest.chunks,regions:manifest.regions,openAndValidateMs,state,memory,coldScanMeasured:false,backgroundSession:true,screenshots:work};
 await app.close();for(const file of files)assert.equal(hash(file.path),file.sha256);result.filesUnchanged=files.length;fs.writeFileSync(path.join(work,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){try{if(page){console.error(await page.locator('#terrain-status').textContent());await page.screenshot({path:path.join(work,'failure.png')});}await app.close();}catch{}throw error;}
