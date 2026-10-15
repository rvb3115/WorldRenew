import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectWorld } from '../engine/world.js';
import { captureVolume } from '../engine/volumes.js';
const source=process.argv[2];if(!source)throw new Error('Pass a path to a world for read-only testing.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/real-volume-'));
function snapshot(dir){return fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(d=>d.isFile()).map(d=>{const file=path.join(d.parentPath,d.name),st=fs.statSync(file);return {file,size:st.size,mtime:st.mtimeMs,hash:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};}).sort((a,b)=>a.file.localeCompare(b.file));}
const before=snapshot(source),world=inspectWorld(source),dim=world.dimensions.find(d=>d.id==='minecraft:overworld'),chunk=dim.regions.flatMap(r=>r.chunks).find(c=>c.valid);
const bounds={minX:chunk.x*16,maxX:chunk.x*16+15,minY:-64,maxY:319,minZ:chunk.z*16,maxZ:chunk.z*16+15};
const captured=captureVolume(world,dim.key,bounds);assert.equal(captured.stats.unknown,0);assert.equal(captured.complete,true);
const env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'app-data')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE;
const app=await electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[root]),`--world=${source}`],env,timeout:30000}),errors=[];
try{const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.click('#open');await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Inspected'));await page.click('#toggle-protection');await page.selectOption('#dimension',dim.key);for(const[id,v]of [['x1',chunk.x],['x2',chunk.x],['z1',chunk.z],['z2',chunk.z]])await page.fill(`#${id}`,String(v));await page.click('#select-area');await page.click('#open-transfer');await page.waitForFunction(()=>document.getElementById('build-status').textContent.includes('Block selection is complete'));await page.waitForFunction(()=>Number(document.getElementById('build-3d').dataset.faceCount)>0);await page.click('#build-view-tools > summary');await page.locator('#build-z').fill(String(bounds.minZ+8));await page.locator('#build-z').dispatchEvent('input');await page.click('#build-fit');await page.screenshot({path:path.join(work,'real-volume.png')});assert.deepEqual(errors,[]);}finally{await app.close();}
assert.deepEqual(snapshot(source),before);
const result={version:world.metadata.version,dataVersion:world.metadata.dataVersion,bounds,stats:captured.stats,blockEntities:captured.attachments.blockEntities.length,filesUnchanged:before.length,desktopErrors:errors};fs.writeFileSync(path.join(work,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));console.log(`PASS real volume; original files unchanged. Screenshot: ${work}`);
