import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
import {UpdateService,defaults} from '../updates/service.js';import {verifyGitHubRelease} from '../updates/github-release.js';
const config={source:'github-releases',repository:'rvb3115/WorldRenew',publicKeys:{}};
const bytes=Buffer.from('non-executable GitHub package fixture'),sha256=createHash('sha256').update(bytes).digest('hex');
function release(version='0.5.9-test.1'){
  const name=`WorldRenew-${version}-macos-arm64.app.zip`,tag=`v${version}`;
  return {id:21,url:'https://api.github.com/repos/rvb3115/WorldRenew/releases/21',tag_name:tag,draft:false,prerelease:version.includes('-'),body:'<script>untrusted notes</script>',assets:[{id:35,state:'uploaded',name,size:bytes.length,digest:`sha256:${sha256}`,browser_download_url:`https://github.com/rvb3115/WorldRenew/releases/download/${tag}/${name}`}]};
}
function fixture(t,{version='0.5.8-test.1',data=release()}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'github-update-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const state={data,bytes,calls:[]};
  const open=async url=>{state.calls.push(url);return Readable.from([url.includes('?per_page')?Buffer.from(JSON.stringify([state.data])):url.includes('api.github.com')?Buffer.from(JSON.stringify(state.data)):state.bytes]);};
  const params={directory:path.join(root,'updates'),config,currentVersion:version,platform:'darwin',arch:'arm64',open};const service=new UpdateService(params);service.saveSettings({...defaults,automaticChecks:false,channel:'beta'});return{root,state,service,params};
}
test('GitHub assets bind repository, exact version/architecture, uploaded identity, size and SHA-256',()=>{
  const good=release(),context={platform:'darwin',arch:'arm64'};assert.equal(verifyGitHubRelease(good,config,context).package.sha256,sha256);
  for(const change of [{digest:null},{size:-1},{state:'new'},{browser_download_url:'https://evil.test/a.zip'},{name:'../bad.zip'},{id:0}])assert.throws(()=>verifyGitHubRelease({...good,assets:[{...good.assets[0],...change}]},config,context));
  for(const change of [{draft:true},{prerelease:false},{url:'https://api.github.com/repos/other/repo/releases/21'}])assert.throws(()=>verifyGitHubRelease({...good,...change},config,context));
  assert.throws(()=>verifyGitHubRelease(good,config,{platform:'darwin',arch:'x64'}));
});
test('newer local builds cannot be downgraded to older public test releases',async t=>{
  const f=fixture(t,{data:release('0.5.5-test.1')});assert.equal((await f.service.check()).release,null);assert.match(f.service.status().message,/older public releases/);assert.equal(f.state.calls.length,1);await assert.rejects(f.service.stage(),/Check for/);
});
test('GitHub test prereleases require Beta; manual check does not download; staging revalidates and preserves profile files',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'templates.wrbuild'),'untouched');f.service.saveSettings(defaults);assert.equal((await f.service.check()).release,null);
  f.service.saveSettings({...defaults,channel:'beta'});assert.equal((await f.service.check()).release.version,'0.5.9-test.1');assert.equal(fs.existsSync(path.join(f.params.directory,'staged.json')),false);
  await f.service.stage();const restarted=new UpdateService(f.params),file=await restarted.verifiedStagedFile();assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.readFileSync(path.join(f.root,'templates.wrbuild'),'utf8'),'untouched');assert.equal(restarted.status().installationSupported,false);
  const newer=new UpdateService({...f.params,currentVersion:'0.6.0'});await assert.rejects(newer.verifiedStagedFile(),/downgrade/);
});
test('changed/revoked GitHub assets and corrupt downloads fail without replacing an earlier receipt',async t=>{
  const f=fixture(t);await f.service.check();await f.service.stage();const receipt=fs.readFileSync(path.join(f.params.directory,'staged.json'));
  f.state.data.assets[0].digest=`sha256:${'0'.repeat(64)}`;await assert.rejects(f.service.stage(),/changed/);assert.deepEqual(fs.readFileSync(path.join(f.params.directory,'staged.json')),receipt);
  f.state.data=release();f.state.bytes=Buffer.alloc(bytes.length);await assert.rejects(f.service.stage(),/checksum/);assert.deepEqual(fs.readFileSync(path.join(f.params.directory,'staged.json')),receipt);
  f.state.data.draft=true;await assert.rejects(f.service.verifiedStagedFile(),/identity/);
});
test('unsigned receipts never authorize a package offline or after release identity tampering',async t=>{
  const f=fixture(t);await f.service.check();await f.service.stage();f.service.open=async()=>{throw new Error('offline');};await assert.rejects(f.service.verifiedStagedFile(),/offline/);
  const {id}=JSON.parse(fs.readFileSync(path.join(f.params.directory,'staged.json'))),file=path.join(f.params.directory,id,'release.json');const receipt=JSON.parse(fs.readFileSync(file));receipt.releaseId='../other';fs.writeFileSync(file,JSON.stringify(receipt));
  await assert.rejects(new UpdateService(f.params).verifiedStagedFile(),/Invalid GitHub release ID/);
});
