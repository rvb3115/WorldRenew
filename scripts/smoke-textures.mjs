import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeBlockWorld,state} from '../tests/transfer-fixtures.js';
import {zip,blockAssets} from '../tests/asset-fixtures.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/texture-smoke-'));
const source=makeBlockWorld(path.join(work,'world'),{block:(x,y,z)=>state(y<4?'stone':'air')}),pack=zip(path.join(work,'test-textures.zip'),blockAssets());
const before=createHash('sha256').update(fs.readFileSync(path.join(source,'dimensions/minecraft/overworld/region/r.0.0.mca'))).digest('hex');
const env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'app-data')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,app=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[root]),`--world=${source}`],env,timeout:30000});const errors=[],network=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 await page.click('#open');await page.waitForFunction(()=>!document.getElementById('open-transfer').disabled);
 assert.equal(await page.isVisible('#protection-panel'),false);await page.screenshot({path:path.join(work,'simple-map.png')});
 await page.click('#open-transfer');await page.waitForFunction(()=>document.getElementById('build-status').textContent.startsWith('Read '));
 assert.equal(await page.isVisible('#build-bounds'),false);assert.equal(await page.isVisible('#build-anchor'),false);
 await page.click('#selection-coordinates > summary');for(const[k,v]of Object.entries({minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}))await page.fill(`#build-${k}`,String(v));await page.click('#build-capture');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},pack);
 await page.click('#choose-textures');await page.waitForFunction(()=>document.getElementById('texture-note').textContent.includes('test-textures.zip')&&!document.getElementById('use-textures').disabled);
 assert.equal(await page.locator('#build-3d').getAttribute('data-texture-count'),'1');
 const faces=await page.locator('#build-3d').getAttribute('data-face-count');await page.click('#build-fit');const textured=await page.locator('#build-3d').screenshot();
 await page.uncheck('#use-textures');await page.waitForFunction(()=>document.getElementById('build-3d').dataset.textureCount==='0');const colored=await page.locator('#build-3d').screenshot();assert.equal(textured.equals(colored),false,'Textures must change actual rendered pixels.');assert.equal(await page.locator('#build-3d').getAttribute('data-face-count'),faces);
 await page.check('#use-textures');await page.waitForFunction(()=>document.getElementById('build-3d').dataset.textureCount==='1'&&!document.getElementById('choose-textures').disabled);
 const bad=path.join(work,'broken.zip');fs.writeFileSync(bad,'not a ZIP');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},bad);await page.click('#choose-textures');await page.waitForFunction(()=>document.getElementById('build-status').classList.contains('error'));assert.equal(await page.locator('#build-3d').getAttribute('data-texture-count'),'1');assert.equal(await page.isDisabled('#build-capture'),false);
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});await page.click('#choose-textures');await page.waitForFunction(()=>document.getElementById('build-status').textContent==='Texture selection canceled.');
 await page.click('#selection-coordinates > summary');await page.locator('.build-view').evaluate(el=>el.scrollTop=0);await page.screenshot({path:path.join(work,'textured-preview.png')});
 // Minimum supported window size must keep controls inside the application.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,760));await page.waitForTimeout(100);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.isVisible('#close-build'));
 await page.screenshot({path:path.join(work,'small-window.png')});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 assert.equal(createHash('sha256').update(fs.readFileSync(path.join(source,'dimensions/minecraft/overworld/region/r.0.0.mca'))).digest('hex'),before);
 console.log(`PASS: simplified panels, texture-pack loading, rendered texture pixels, color toggle without geometry changes, damaged/canceled pack handling, minimum window, zero network requests, unchanged source.\nScreenshots: ${work}`);
}finally{await app.close();}
