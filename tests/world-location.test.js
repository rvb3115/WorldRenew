import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import location from '../desktop/world-location.cjs';
const {defaultWorldDirectory,rememberedDirectory,rememberWorldDirectory}=location;
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'world-location-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('Mac discovery uses home and Windows uses APPDATA, without searching or creating absent saves',t=>{
  const home=fixture(t),mac=path.join(home,'Library/Application Support/minecraft/saves'),roaming=path.join(home,'Roaming'),win=path.join(roaming,'.minecraft/saves');
  assert.equal(defaultWorldDirectory({platform:'darwin',home}),home);assert.equal(fs.existsSync(mac),false);
  fs.mkdirSync(mac,{recursive:true});fs.mkdirSync(win,{recursive:true});
  assert.equal(defaultWorldDirectory({platform:'darwin',home}),mac);assert.equal(defaultWorldDirectory({platform:'win32',home,env:{APPDATA:roaming}}),win);
  assert.equal(defaultWorldDirectory({platform:'win32',home,appData:roaming,env:{}}),win);
});
test('valid custom location wins; stale/relative/file locations fall back without modifying worlds',t=>{
  const home=fixture(t),custom=path.join(home,'custom save'),profile=path.join(home,'isolated-profile');fs.mkdirSync(custom);fs.writeFileSync(path.join(custom,'level.dat'),'original');
  rememberWorldDirectory(profile,custom);assert.equal(rememberedDirectory(profile),custom);assert.equal(defaultWorldDirectory({platform:'darwin',home,remembered:custom}),custom);
  assert.equal(defaultWorldDirectory({platform:'darwin',home,remembered:path.join(custom,'level.dat')}),home);assert.equal(defaultWorldDirectory({platform:'darwin',home,remembered:'relative'}),home);
  assert.throws(()=>rememberWorldDirectory(path.join(custom,'profile'),custom),/Unsafe/);assert.equal(fs.readFileSync(path.join(custom,'level.dat'),'utf8'),'original');
  fs.renameSync(custom,custom+' moved');assert.equal(rememberedDirectory(profile),undefined);
});
test('chooser preferences are isolated per profile and corrupt/symlink preferences are ignored',t=>{
  const root=fixture(t),world=path.join(root,'world'),regular=path.join(root,'regular'),isolated=path.join(root,'isolated');fs.mkdirSync(world);
  rememberWorldDirectory(isolated,world);assert.equal(rememberedDirectory(regular),undefined);assert.equal(fs.existsSync(regular),false);
  fs.writeFileSync(path.join(isolated,'world-location.json'),'{bad');assert.equal(rememberedDirectory(isolated),undefined);
  fs.rmSync(path.join(isolated,'world-location.json'));fs.symlinkSync(path.join(root,'missing'),path.join(isolated,'world-location.json'));assert.equal(rememberedDirectory(isolated),undefined);
});
