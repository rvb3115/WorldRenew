// Explicit local installation helper, never invoked by the application's updater.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {execFileSync,spawnSync} from 'node:child_process';import {createHash,randomUUID} from 'node:crypto';import {extractFile} from '@electron/asar';import {compareVersions} from '../updates/version.js';
assert.equal(process.platform,'darwin','This helper installs the tested Mac bundle only.');assert.equal(process.argv.length,3,'Usage: node scripts/install-macos.mjs /tested/WorldRenew.app');
const source=fs.realpathSync(process.argv[2]),applications=path.join(os.homedir(),'Applications'),target=path.join(applications,'WorldRenew.app');
assert.ok(source.endsWith('.app')&&source!==target);
const version=bundle=>JSON.parse(extractFile(path.join(bundle,'Contents/Resources/app.asar'),'package.json')).version;
const currentVersion=version(source);assert.equal(currentVersion,JSON.parse(fs.readFileSync('package.json','utf8')).version,'Install the version under test.');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ordinary(directory){for(let p=directory;;p=path.dirname(p)){if(fs.existsSync(p))assert.ok(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink(),`Expected an ordinary directory: ${p}`);if(p===path.dirname(p))break;}}
function assertClosed(){const processes=execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'});assert.ok(!processes.split('\n').some(line=>line.includes(path.join(target,'Contents/MacOS/WorldRenew'))),'The installed app is running. Save your work and close that copy before replacing it; no process was closed.');}
ordinary(applications);if(fs.existsSync(target)){assert.ok(!fs.lstatSync(target).isSymbolicLink());assert.ok(compareVersions(currentVersion,version(target))>=0,'Refusing to replace a newer installed app.');}assertClosed();
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',source]);
fs.mkdirSync(applications,{recursive:true});const staging=path.join(applications,`.WorldRenew-install-${randomUUID()}.app`);let backup=null;
try{
  execFileSync('/usr/bin/ditto',[source,staging]);execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',staging]);
  const payloadHash=hash(path.join(source,'Contents/Resources/app.asar'));assert.equal(hash(path.join(staging,'Contents/Resources/app.asar')),payloadHash);assert.equal(version(staging),currentVersion);
  assertClosed();
  if(fs.existsSync(target)){const backups=path.join(applications,'.WorldRenew Backups.noindex');ordinary(backups);fs.mkdirSync(backups,{recursive:true});backup=path.join(backups,`WorldRenew-${version(target)}-${Date.now()}.app`);fs.renameSync(target,backup);}
  try{fs.renameSync(staging,target);}catch(error){if(backup&&!fs.existsSync(target))fs.renameSync(backup,target);throw error;}
  const registry='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  const registration=[];
  for(const args of [...(backup?[['-u',backup]]:[]),['-f',target]]){
    const result=spawnSync(registry,args,{encoding:'utf8'});
    registration.push({action:args[0],path:args[1],passed:result.status===0,error:result.status===0?null:String(result.error??result.stderr??result.status)});
  }
  console.log(JSON.stringify({installed:true,version:currentVersion,target,backup,sha256:payloadHash,registration,userDataModified:false,activeTestSessionClosed:false,securityWarningsBypassed:false,automaticUpdater:false},null,2));
  if(registration.some(result=>!result.passed))process.exitCode=1;
}finally{fs.rmSync(staging,{recursive:true,force:true});}
