import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createChunkReader, decodeSection, isAir } from './chunks.js';
import { canonicalWorld, readBounded, safePath } from './paths.js';
import { requireThat } from './errors.js';
import { terrainColor } from './terrain-colors.js';
import { terrainSupport, terrainVersions, terrainHeights, TERRAIN_BATCH_LIMIT, TERRAIN_CACHE_LIMIT } from './terrain-policy.js';
import { TerrainDiskCache } from './terrain-disk-cache.js';
import { summarizeTerrain, TERRAIN_SUMMARY_SCHEMA } from './terrain-summary.js';

export function terrainOptions(metadata, dimension, request = {}) {
  const reason = terrainSupport(metadata, dimension);
  requireThat(!reason, 'TERRAIN_UNSUPPORTED', reason);
  const heights = terrainHeights[dimension.id], mode = request.mode ?? (dimension.id === 'minecraft:the_nether' ? 'caverns' : 'surface');
  requireThat(['surface', 'caverns', 'roof', 'cutaway'].includes(mode), 'TERRAIN_VIEW', 'Unknown terrain view.');
  requireThat(!['caverns', 'roof'].includes(mode) || dimension.id === 'minecraft:the_nether', 'TERRAIN_VIEW', 'Roof and cavern views are Nether-only.');
  let { minY, maxY } = heights;
  if (mode === 'caverns') maxY = 127;
  if (mode === 'roof') minY = 128;
  if (mode === 'cutaway') {
    requireThat(Number.isInteger(request.y) && request.y >= minY && request.y <= maxY, 'TERRAIN_VIEW', `Choose a cutaway height from ${minY} to ${maxY}.`);
    maxY = request.y;
  }
  return { mode, minY, maxY, dataVersion: metadata.dataVersion };
}

/** A 16×16 tile derived from disk block states. No world or NBT data is mutated. */
export function projectTerrain(nbt, options, dimensionId) {
  requireThat(Object.values(terrainVersions).includes(nbt.DataVersion) && nbt.DataVersion <= options.dataVersion, 'TERRAIN_UNSUPPORTED', `Chunk DataVersion ${nbt.DataVersion ?? 'missing'} has no applicable terrain adapter for this world; terrain was not inferred.`);
  const heights = terrainHeights[dimensionId], sections = new Map();
  // 1.21.11 uses the post-1.18 root section list and legacy Name/Properties
  // palette compounds. Verify that exact schema, not just its version label.
  if (nbt.DataVersion === 4671) {
    requireThat(nbt.Level === undefined && nbt.Sections === undefined && Number.isInteger(nbt.xPos) && Number.isInteger(nbt.zPos) && ['minecraft:full', 'full'].includes(nbt.Status), 'TERRAIN_SCHEMA', 'Unsupported 1.21.11 chunk root or incomplete generation.');
    requireThat(nbt.yPos === Math.floor(heights.minY / 16), 'TERRAIN_UNSUPPORTED', '1.21.11 chunk minimum section height is missing or non-vanilla; terrain was not inferred.');
  }
  requireThat(Array.isArray(nbt.sections) && nbt.sections.length <= 32, 'TERRAIN_SECTIONS', 'Unsupported section list.');
  for (const section of nbt.sections) {
    requireThat(section && typeof section === 'object' && !Array.isArray(section) && Number.isInteger(section.Y) && !sections.has(section.Y), 'SECTION_DUPLICATE', 'Missing or duplicate section Y.');
    if (section.block_states) requireThat(section.Y >= Math.floor(heights.minY / 16) && section.Y <= Math.floor(heights.maxY / 16), 'TERRAIN_UNSUPPORTED', 'Custom dimension height is unsupported.');
    if (nbt.DataVersion === 4671 && section.block_states) {
      const palette = section.block_states.palette;
      requireThat(Array.isArray(palette) && palette.length > 0 && palette.length <= 4096 && palette.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.Name === 'string' && Object.keys(entry).every(key => key === 'Name' || key === 'Properties')), 'TERRAIN_SCHEMA', '1.21.11 requires Name/Properties block-state compounds; compact or mixed schemas are unsupported.');
    }
    // Validate every supplied palette in the selected height range, even below a visible surface.
    sections.set(section.Y, section.block_states && section.Y >= Math.floor(options.minY / 16) && section.Y <= Math.floor(options.maxY / 16) ? decodeSection(section) : null);
  }
  for (let sy = Math.floor(options.minY / 16); sy <= Math.floor(options.maxY / 16); sy++)
    requireThat(sections.get(sy), 'TERRAIN_SECTION_MISSING', `Section Y ${sy} is missing block data. Unknown terrain is not air.`);
  const top = new Int16Array(256).fill(-32768), ids = new Uint16Array(256), palette = [''], paletteIds = new Map();
  let fallbackColumns = 0;
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    let airRun = 0;
    for (let y = options.maxY; y >= options.minY; y--) {
      const s = sections.get(Math.floor(y / 16)), state = s.palette[s.indices[((y % 16 + 16) % 16) * 256 + z * 16 + x]];
      if (isAir(state)) { airRun++; continue; }
      if (options.mode === 'caverns' && airRun < 3) { airRun = 0; continue; }
      const i = z * 16 + x;
      top[i] = y;
      if (!paletteIds.has(state.Name)) { paletteIds.set(state.Name, palette.length); palette.push(state.Name); }
      ids[i] = paletteIds.get(state.Name);
      if (terrainColor(state.Name).approximate) fallbackColumns++;
      break;
    }
  }
  const rgba = new Uint8ClampedArray(1024);
  for (let i = 0; i < 256; i++) {
    const { rgb } = terrainColor(palette[ids[i]]);
    // North-facing relief and absolute elevation; deterministic at chunk boundaries.
    const north = i >= 16 && ids[i - 16] ? top[i - 16] : top[i];
    const shade = Math.max(.65, Math.min(1.2, .93 + (top[i] - north) * .035 + (top[i] - 64) * .0006));
    const color = ids[i] ? rgb : options.mode === 'caverns' ? 0x39464f : 0x162831;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.min(255, ((color >> (16 - 8 * c)) & 255) * (ids[i] ? shade : 1));
    rgba[i * 4 + 3] = 255;
  }
  return { status: 'ready', rgba, heights: top, ids, palette, fallbackColumns, emptyLabel: options.mode === 'caverns' ? 'No exposed floor with 3 blocks of air below the roof' : 'No non-air blocks in this height range' };
}

/** Session-only LRU of projected pixels, never raw chunks. One request is at most 16 chunks. */
export function createTerrainReader(world, { cacheLimit = TERRAIN_CACHE_LIMIT, cacheDirectory } = {}) {
  requireThat(Number.isInteger(cacheLimit) && cacheLimit >= 1 && cacheLimit <= TERRAIN_CACHE_LIMIT, 'TERRAIN_CACHE', 'Invalid terrain cache limit.');
  const root = canonicalWorld(world.root), cache = new Map(), regionCache = new Map();
  const disk = cacheDirectory ? new TerrainDiskCache(cacheDirectory, world) : null;
  const documents = new Map(), regionIndexes = new Map(world.dimensions.map(d => [d.key, new Map((d.regions??[]).map(r=>[`${r.rx},${r.rz}`,r]))]));
  const metrics = { decoded: 0, readAttempts: 0, memoryHits: 0, diskHits: 0 };
  const stamp = relative => {
    try { const s = fs.statSync(safePath(root, relative)); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  };
  const metadataStable = () => requireThat(createHash('sha256').update(readBounded(root, 'level.dat', 16 * 1024 * 1024)).digest('hex') === world.fingerprint, 'WORLD_CHANGED', 'World metadata changed. Refresh the world map.');
  function regionDocument(dimension, options, rx, rz) {
    const r = regionIndexes.get(dimension.key)?.get(`${rx},${rz}`);
    if (!r) return null;
    const current = stamp(r.path), s = r.sourceStamp;
    requireThat(current === `${s.bytes}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`, 'WORLD_CHANGED', 'A region changed since inspection. Refresh the map to update its chunk index.');
    const externals = r.externals ?? r.chunks?.filter(c=>c.external).map(c=>({x:c.x,z:c.z})) ?? [];
    const sourceStamp = createHash('sha256').update(current + '|' + externals.map(c=>`${c.x},${c.z}:${stamp(path.join(path.dirname(r.path),`c.${c.x}.${c.z}.mcc`))}`).join('|')).digest('hex');
    const identity = JSON.stringify([TERRAIN_SUMMARY_SCHEMA,root,world.fingerprint,dimension.key,dimension.id,options,rx,rz]);
    let doc = documents.get(identity);
    if (!doc || doc.sourceStamp !== sourceStamp) {
      const entries = disk?.read(identity,sourceStamp) ?? [];
      metrics.diskHits += entries.length;
      doc = {identity,sourceStamp,entries:new Map(entries.map(e=>[e[0],e]))};
    }
    documents.delete(identity); documents.set(identity,doc);
    while(documents.size>64)documents.delete(documents.keys().next().value);
    return doc;
  }
  function context(request) {
    const dimension = world.dimensions.find(d=>d.key===request?.dimension);
    requireThat(dimension,'TERRAIN_DIMENSION','Choose an inspected dimension.');
    return {dimension,options:terrainOptions(world.metadata,dimension,request)};
  }
  const stats = () => ({...metrics,cacheEntries:cache.size,disk:disk?.stats??null});
  function overview(request) {
    requireThat(Array.isArray(request?.regions)&&request.regions.length>0&&request.regions.length<=32,'TERRAIN_LIMIT','Validate 1–32 overview regions per request.');
    const {dimension,options}=context(request);metadataStable();
    const regions=request.regions.map(({rx,rz})=>{
      requireThat(Number.isInteger(rx)&&Number.isInteger(rz),'TERRAIN_COORDINATES','Invalid region coordinates.');
      const doc=regionDocument(dimension,options,rx,rz);
      requireThat(doc,'TERRAIN_REGION','Region is not in the inspected index.');
      return {rx,rz,sourceStamp:doc.sourceStamp,entries:[...doc.entries.values()]};
    });
    metadataStable();return {regions,...stats()};
  }
  function batch(request) {
    requireThat(request && Array.isArray(request.chunks) && request.chunks.length > 0 && request.chunks.length <= TERRAIN_BATCH_LIMIT, 'TERRAIN_LIMIT', `Request 1–${TERRAIN_BATCH_LIMIT} chunks at a time.`);
    requireThat(request.chunks.every(c => c && Number.isInteger(c.x) && Number.isInteger(c.z) && Math.abs(c.x) <= 1875000 && Math.abs(c.z) <= 1875000), 'TERRAIN_COORDINATES', 'Terrain coordinates must be chunks inside the vanilla world border.');
    const {dimension,options}=context(request);
    metadataStable();
    const results = [], summaries = [], touched = new Map(), validated = new Map();
    for (const { x, z } of request.chunks) {
      const regionKey=`${Math.floor(x/32)},${Math.floor(z/32)}`;
      if(disk&&!validated.has(regionKey))validated.set(regionKey,regionDocument(dimension,options,Math.floor(x/32),Math.floor(z/32)));
      const doc=validated.get(regionKey),slot=((z%32+32)%32)*32+((x%32+32)%32);
      if(request.summaryOnly&&doc?.entries.has(slot)) {const e=doc.entries.get(slot);summaries.push({x,z,state:e[1],rgb:e[2]});continue;}
      const id = `${dimension.key}:${options.mode}:${options.maxY}:${x},${z}`;
      const directory = path.join(dimension.path === '.' ? '' : dimension.path, 'region');
      const region = path.join(directory, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`), external = path.join(directory, `c.${x}.${z}.mcc`);
      let value, storageStamp;
      try {
        storageStamp = stamp(region) + '|' + stamp(external);
        const old = cache.get(id);
        if (old?.storageStamp === storageStamp) { cache.delete(id); cache.set(id, old); value=old.value; metrics.memoryHits++; }
        else {
        // Per-chunk reader releases expanded NBT immediately after projection. Its 32 MiB
        // record and 128 MiB expansion guards remain intact; no raw data enters the LRU.
        metrics.readAttempts++;
        const reader = createChunkReader(root, dimension, {regionCache}), chunk = reader.read(x, z);
        for (const region of reader.regions.values()) requireThat(!region?.issues.length, 'CHUNK_ALLOCATION', 'Region has structural errors; absence cannot be established.');
        value = chunk ? projectTerrain(chunk.nbt, options, dimension.id) : { status: 'absent', message: 'No saved chunk record.' };
        reader.verifyStable();
        requireThat(storageStamp === stamp(region) + '|' + stamp(external), 'CHUNK_CHANGED', 'Terrain changed while loading. Refresh the map.');
        metrics.decoded++;
        }
      } catch (error) { value = { status: error.code === 'TERRAIN_UNSUPPORTED' ? 'unsupported' : 'unreadable', code: error.code ?? 'IO_ERROR', message: error.message }; }
      if(value.x!==x||value.z!==z)value = { x, z, ...value };
      // Errors can be retried after refresh, but do not create a redraw/retry storm.
      cache.delete(id); cache.set(id, { storageStamp, value });
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      const summary=summarizeTerrain(value);summaries.push({x,z,...summary});
      if(doc){doc.entries.set(slot,[slot,summary.state,summary.rgb]);touched.set(doc.identity,doc);}
      if(!request.summaryOnly)results.push(value);
    }
    metadataStable();
    for(const doc of touched.values())disk.write(doc.identity,doc.sourceStamp,[...doc.entries.values()]);
    return { tiles: results, summaries, ...stats() };
  }
  return { batch, overview, get cacheSize() { return cache.size; }, get stats() { return stats(); } };
}
