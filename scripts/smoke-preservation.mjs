import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {preservationWorld} from '../tests/preservation-fixtures.js';
import {inventory,hashFile} from '../engine/safety.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=fs.mkdtempSync(path.join(root,'work/preservation-smoke-'));
const fixture=preservationWorld(path.join(work,'synthetic-world'),{removalHasContents:true}),snapshot=()=>inventory(fixture).files.map(f=>[f.path,hashFile(path.join(fixture,f.path))]),before=snapshot();
const env={...process.env,WORLDRENEW_USER_DATA:path.join(work,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.WORLDRENEW_EXECUTABLE,app=await electron.launch({...executablePath?{executablePath}:{},args:[...executablePath?[]:[root],`--world=${fixture}`],env,timeout:30000});
try{
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.click('#open');await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Inspected'));
  await page.click('#toggle-protection');for(const[id,n]of Object.entries({x1:4,x2:4,z1:0,z2:0}))await page.fill('#'+id,String(n));await page.click('#select-area');await page.click('#preview');
  await page.waitForFunction(()=>document.getElementById('regeneration-eligibility').textContent.includes('container inventories'));
  assert.match(await page.textContent('#regeneration-eligibility'),/entities/);await page.check('#closed');await page.check('#regeneration-ack');assert.equal(await page.locator('#export-regeneration').isDisabled(),true);
  await page.screenshot({path:path.join(work,'container-removal-blocked.png')});assert.deepEqual(snapshot(),before);assert.deepEqual(errors,[]);
  const report={passed:true,fixtureOnly:true,checks:['container and entity blockers visible','generic acknowledgements do not override inventory preservation','export disabled','source hashes unchanged'],screenshots:work};fs.writeFileSync(path.join(work,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app.close();}
