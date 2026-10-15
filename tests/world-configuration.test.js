import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDat, makeWorld } from './fixtures.js';
import { createRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import { makeBlockWorld, state } from './transfer-fixtures.js';
import { placementWorld } from './placement-fixtures.js';
import { inspectWorld } from '../engine/world.js';
import { configurationSummary, readWorldConfiguration } from '../engine/world-configuration.js';
import { captureBuildArchive, saveBuildFile, readBuildFile, sha } from '../engine/build-archive.js';
import { previewBuildFile, createPlacedCopy } from '../engine/copy-placement.js';
import { createTerrainReader } from '../engine/terrain.js';
const dimension = w => w.dimensions.find(d => d.id === 'minecraft:overworld').key;
function config(root, version = '26.2', dataVersion = 4903) {
  writeDat(path.join(root,'level.dat'), { Data: [10, { LevelName: [8,'Vanilla datapack fixture'], SpawnX:[3,1024], SpawnY:[3,64], SpawnZ:[3,1024], DataVersion: [3,dataVersion], Version: [10,{Name:[8,version],Id:[3,dataVersion],Snapshot:[1,0]}],
    enabled_features: [9,{type:8,values:['minecraft:vanilla','minecraft:trade_rebalance']}], removed_features: [9,{type:8,values:['minecraft:update_1_20']}],
    DataPacks: [10,{Enabled:[9,{type:8,values:['vanilla','trade_rebalance','file/landscape']}],Disabled:[9,{type:8,values:[]}]}], WasModded:[1,0] }] });
  writeDat(path.join(root,'data/minecraft/world_gen_settings.dat'), {data:[10,{seed:[4,42n],generate_structures:[1,1],dimensions:[10,{'minecraft:overworld':[10,{type:[8,'minecraft:overworld'],generator:[10,{type:[8,'minecraft:noise'],settings:[8,'minecraft:amplified']}]}]}]}]});
  fs.mkdirSync(path.join(root,'datapacks/landscape'),{recursive:true}); fs.writeFileSync(path.join(root,'datapacks/landscape/pack.mcmeta'),JSON.stringify({pack:{description:'Synthetic configuration preservation fixture',pack_format:101}}));
}
function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-config-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=makeBlockWorld(path.join(base,'source'),{version:'26.2',dataVersion:4903,block:()=>state('oak_planks')});config(root);
  const destinationRoot=placementWorld(path.join(base,'destination'));config(destinationRoot);
  return {base,root,world:inspectWorld(root),destination:inspectWorld(destinationRoot)};
}
test('records explicit feature/datapack evidence and split generation settings without guessing history', t => {
  const f=fixture(t), c=f.world.metadata.configuration;
  assert.deepEqual(c.enabledFeatures,['minecraft:vanilla','minecraft:trade_rebalance']);assert.deepEqual(c.removedFeatures,['minecraft:update_1_20']);
  assert.equal(c.generationSource,'data/minecraft/world_gen_settings.dat');assert.equal(c.generatorSettings[0].settings,'minecraft:amplified');assert.equal(c.generateStructures,1);
  assert.equal(configurationSummary({WasModded:1}).enabledFeatures,null);assert.match(configurationSummary({}).featureHistory,/Unknown/);
  assert.equal(configurationSummary({enabled_features:[]}).enabledFeatures.length,0);
  assert.match(configurationSummary({enabled_features:'bad'}).notices.join(' '),/unrecognized shape/);
});
test('experimental flags permit supported archive/placement while configuration and datapack bytes survive unchanged', t => {
  const f=fixture(t), archive=captureBuildArchive(f.world,dimension(f.world),{minX:0,maxX:3,minY:0,maxY:3,minZ:0,maxZ:3}),file=path.join(f.base,'flagged.wrbuild');saveBuildFile(file,archive);
  assert.deepEqual(archive.source.configuration.fields.enabled_features,['minecraft:vanilla','minecraft:trade_rebalance']);
  assert.deepEqual(readBuildFile(file).archive.source.configuration,structuredClone(archive.source.configuration));
  const anchor={x:20,y:2,z:20}, plan=previewBuildFile(file,f.destination,dimension(f.destination),anchor);
  assert.equal(plan.copyEligible,true);assert.match(plan.warnings.join(' '),/feature flags/);
  const paths=['level.dat','data/minecraft/world_gen_settings.dat','datapacks/landscape/pack.mcmeta'];
  const before=paths.map(p=>sha(fs.readFileSync(path.join(f.destination.root,p))));
  const result=createPlacedCopy(file,f.destination,dimension(f.destination),anchor,f.base,{confirmedClosed:true,reviewDigest:plan.reviewDigest});
  for(const root of [result.world,result.backup,f.destination.root])assert.deepEqual(paths.map(p=>sha(fs.readFileSync(path.join(root,p)))),before);
});
test('changed datapack bytes invalidate rewrite review without banning the datapack itself', t => {
  const f=fixture(t),file=path.join(f.base,'build.wrbuild');saveBuildFile(file,captureBuildArchive(f.world,dimension(f.world),{minX:0,maxX:3,minY:0,maxY:3,minZ:0,maxZ:3}));
  const anchor={x:20,y:2,z:20},plan=previewBuildFile(file,f.destination,dimension(f.destination),anchor);
  fs.appendFileSync(path.join(f.destination.root,'datapacks/landscape/pack.mcmeta'),'\n');
  assert.throws(()=>createPlacedCopy(file,f.destination,dimension(f.destination),anchor,f.base,{confirmedClosed:true,reviewDigest:plan.reviewDigest}),{code:'PLACEMENT_STALE'});
  assert.equal(previewBuildFile(file,f.destination,dimension(f.destination),anchor).copyEligible,true);
});
test('supported terrain still loads with experimental flags and datapacks enabled', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-config-terrain-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  makeBlockWorld(base,{dataVersion:5023,sections:Array.from({length:24},(_,i)=>i-4),block:(_x,y)=>state(y<=64?'stone':'air')});config(base,'26.3',5023);
  const world=inspectWorld(base),tiles=createTerrainReader(world).batch({dimension:dimension(world),chunks:[{x:0,z:0}]});assert.equal(tiles.tiles[0].status,'ready');
});
test('configuration size guard applies to rewrite fingerprinting; archive capture does not read pack payloads', t => {
  const f=fixture(t),large=path.join(f.root,'datapacks/large.zip'),fd=fs.openSync(large,'w');fs.ftruncateSync(fd,64*1024*1024+1);fs.closeSync(fd);
  assert.throws(()=>readWorldConfiguration(f.root),{code:'CONFIGURATION_LIMIT'});
  const archive=captureBuildArchive(f.world,dimension(f.world),{minX:0,maxX:3,minY:0,maxY:3,minZ:0,maxZ:3});
  assert.equal(archive.source.configuration.packFiles,null);assert.equal(inspectWorld(f.root).metadata.configuration.enabledFeatures.length,2);
});

test('experimental datapack configuration permits supported chunk removal and remains byte-exact in backup and result', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'worldrenew-config-regeneration-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=makeWorld(path.join(base,'source'),{dataVersion:5023});config(root,'26.3',5023);
  const world=inspectWorld(root),plan=createRegenerationReview(world,[{dimension:dimension(world),x:0,z:0}],[],{bufferChunks:0});
  assert.equal(plan.copyExport.eligible,true);assert.match(plan.warnings.join(' '),/feature flags/);
  const paths=['level.dat','data/minecraft/world_gen_settings.dat','datapacks/landscape/pack.mcmeta'];
  const before=paths.map(p=>sha(fs.readFileSync(path.join(root,p))));
  const result=createRegeneratedCopy(world,plan,base,{confirmedClosed:true,confirmedExperimental:true});
  for(const output of [root,result.backup,result.world])assert.deepEqual(paths.map(p=>sha(fs.readFileSync(path.join(output,p)))),before);
});
