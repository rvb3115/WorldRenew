import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeLargeOverviewWorld, legacyOverviewOrder, localOverviewOrder } from '../tests/large-overview-fixtures.js';

const script = fileURLToPath(import.meta.url), repo = path.dirname(path.dirname(script));
const digest = data => createHash('sha256').update(data).digest('hex');
function options(argv) {
  const result = { chunks: 2560, regions: 80, strategy: 'both', maxRequests: Infinity, seconds: 120, warm: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { console.log('node scripts/benchmark-large-overview.mjs [--chunks 247895] [--regions 243] [--strategy baseline|local|progressive|both|all] [--engine-root path/to/frozen/repo] [--max-requests 1024] [--seconds 120] [--fixture generated-root] [--output work/performance-name] [--resume-cache generated-cache-path] [--warm]'); process.exit(0); }
    if (key === '--warm') { result.warm = true; continue; }
    const names = { '--chunks': 'chunks', '--regions': 'regions', '--strategy': 'strategy', '--max-requests': 'maxRequests', '--seconds': 'seconds', '--fixture': 'fixture', '--output': 'output', '--engine-root': 'engineRoot', '--resume-cache': 'resumeCache' };
    if (!names[key] || !argv[i + 1]) throw new Error(`Unknown or missing argument ${key}`);
    result[names[key]] = ['chunks', 'regions', 'maxRequests', 'seconds'].includes(names[key]) ? Number(argv[++i]) : argv[++i];
  }
  if (!argv.includes('--regions')) result.regions = Math.min(result.chunks, Math.max(80, Math.ceil(result.chunks / 1024)));
  if (!['baseline', 'local', 'progressive', 'both', 'all'].includes(result.strategy) || !Number.isInteger(result.chunks) || result.chunks < 1 || !Number.isInteger(result.regions) || result.regions < 1 || !Number.isFinite(result.seconds) || result.seconds <= 0 || !(result.maxRequests === Infinity || Number.isInteger(result.maxRequests) && result.maxRequests > 0)) throw new Error('Invalid benchmark options.');
  if (result.resumeCache && (!result.fixture || ['both', 'all'].includes(result.strategy))) throw new Error('Resuming requires an existing generated fixture and one strategy.');
  return result;
}

// Count successful calls/bytes at the JS fs boundary. Nested readFile/writeFile
// implementation calls are suppressed to avoid counting the same bytes twice.
// These are requested/returned bytes, not physical device I/O or OS page faults.
function instrumentIO(worldRoot, cacheRoot) {
  const originals = {}, fds = new Map(); let nestedRead = 0, nestedWrite = 0;
  let metrics;
  const blank = () => ({ openCalls: 0, readCalls: 0, readBytes: 0, writeCalls: 0, writeBytes: 0, statCalls: 0, renameCalls: 0, headerReads: 0, envelopeReads: 0 });
  function reset() { metrics = { region: blank(), metadata: blank(), cache: blank(), other: blank() }; }
  reset();
  function category(value) { const file = typeof value === 'number' ? fds.get(value) : value instanceof URL ? fileURLToPath(value) : String(value); return file?.startsWith(cacheRoot + path.sep) ? metrics.cache : file?.endsWith('.mca') && file.startsWith(worldRoot + path.sep) ? metrics.region : file?.startsWith(worldRoot + path.sep) ? metrics.metadata : metrics.other; }
  function wrap(name, fn) { originals[name] = fs[name]; fs[name] = (...args) => fn(originals[name], args); }
  wrap('openSync', (original, args) => { const fd = original(...args); fds.set(fd, String(args[0])); category(args[0]).openCalls++; return fd; });
  wrap('closeSync', (original, args) => { const result = original(...args); fds.delete(args[0]); return result; });
  wrap('readSync', (original, args) => { const count = original(...args); if (!nestedRead) { const m = category(args[0]); m.readCalls++; m.readBytes += count; if (count === 8192 && args[4] === 0) m.headerReads++; if (count === 5) m.envelopeReads++; } return count; });
  wrap('readFileSync', (original, args) => { nestedRead++; let result; try { result = original(...args); } finally { nestedRead--; } if (!nestedRead) { const m = category(args[0]); m.readCalls++; m.readBytes += Buffer.byteLength(result); } return result; });
  wrap('writeSync', (original, args) => { const count = original(...args); if (!nestedWrite) { const m = category(args[0]); m.writeCalls++; m.writeBytes += count; } return count; });
  wrap('writeFileSync', (original, args) => { nestedWrite++; let result; try { result = original(...args); } finally { nestedWrite--; } if (!nestedWrite) { const m = category(args[0]); m.writeCalls++; m.writeBytes += Buffer.byteLength(args[1]); } return result; });
  for (const name of ['statSync', 'lstatSync', 'fstatSync']) wrap(name, (original, args) => { const result = original(...args); category(args[0]).statCalls++; return result; });
  wrap('renameSync', (original, args) => { const result = original(...args); category(args[0]).renameCalls++; return result; });
  return { reset, snapshot: () => structuredClone(metrics), restore: () => { for (const [name, fn] of Object.entries(originals)) fs[name] = fn; } };
}

async function runWorker(config) {
  const { root, cache, output, strategy, seconds, warm, resume } = config, maxRequests = config.maxRequests ?? Infinity;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'benchmark-fixture.json'), 'utf8'));
  assert.equal(manifest.generatedOnly, true); assert.equal(manifest.playable, false);
  const engineRoot = config.engineRoot ?? repo;
  const [{ inspectWorld }, { createTerrainReader }, { CompactOverview, OverviewQueue }] = await Promise.all([
    import(pathToFileURL(path.join(engineRoot, 'engine/world.js'))), import(pathToFileURL(path.join(engineRoot, 'engine/terrain.js'))), import('../ui/terrain-overview.js')
  ]);
  const sourceHashes = Object.fromEntries(['engine/terrain.js', 'engine/chunks.js', 'engine/anvil.js', 'engine/terrain-disk-cache.js', 'engine/terrain-summary.js'].map(file => [file, digest(fs.readFileSync(path.join(engineRoot, file)))]));
  sourceHashes['queue:ui/terrain-overview.js'] = digest(fs.readFileSync(path.join(repo, 'ui/terrain-overview.js')));
  const io = instrumentIO(root, cache), indexStart = performance.now();
  const world = inspectWorld(root), indexMs = performance.now() - indexStart, indexIO = io.snapshot();
  const dimension = world.dimensions.find(d => d.id === 'minecraft:overworld');
  assert.equal(dimension.chunkCount, manifest.chunks); assert.equal(dimension.regions.length, manifest.regions);
  assert.equal(dimension.invalidChunks, 0); assert.equal(dimension.unreadableRegions.length, 0);
  const regions = dimension.regions, order = strategy === 'baseline' ? legacyOverviewOrder : localOverviewOrder;
  const coarse = new CompactOverview(new Map(regions.flatMap(r => r.chunks).map((c, i) => [`${c.x},${c.z}`, i])));
  io.reset();
  const start = performance.now(), cpu = process.cpuUsage(), rssStart = process.memoryUsage().rss;
  let rssPeakSampled = rssStart, requests = 0, completed = 0, initialCached = 0, validationRequests = 0, stopped = null, reader, firstBatchMs = null, firstAllRegionsSampled = null;
  const states = {}, samples = [], coveredRegions = new Set(), summaryHash = createHash('sha256');
  reader = createTerrainReader(world, { cacheDirectory: cache });
  if (warm || resume) {
    for (let i = 0; i < regions.length; i += 32) { const result = reader.overview({ dimension: dimension.key, regions: regions.slice(i, i + 32).map(({ rx, rz }) => ({ rx, rz })) }); validationRequests++; for (const r of result.regions) for (const [slot, state, rgb] of r.entries) { coarse.set(`${r.rx * 32 + slot % 32},${r.rz * 32 + Math.floor(slot / 32)}`, { state, rgb }); states[state] = (states[state] ?? 0) + 1; coveredRegions.add(`${r.rx},${r.rz}`); completed++; } }
    initialCached = completed;
    if (coveredRegions.size === regions.length) firstAllRegionsSampled = { wallMs: performance.now() - start, completed, requests: 0, regions: coveredRegions.size, cached: true };
    if (warm) requests = validationRequests;
  }
  if (!warm) {
    const iterator = order(regions), queue = strategy === 'progressive' ? new OverviewQueue(coarse) : null; let done = false;
    if (queue) for (const region of regions) queue.add(region);
    while (!done) {
      if (requests >= maxRequests || (performance.now() - start) / 1000 >= seconds) { stopped = requests >= maxRequests ? 'maxRequests' : 'seconds'; break; }
      const batch = queue ? queue.take(16).map(({ x, z }) => ({ x, z })) : [];
      if (!queue) while (batch.length < 16) { const next = iterator.next(); if (next.done) { done = true; break; } if (!coarse.has(`${next.value.x},${next.value.z}`)) batch.push({ x: next.value.x, z: next.value.z }); }
      if (!batch.length) break;
      const response = reader.batch({ dimension: dimension.key, chunks: batch, summaryOnly: true });
      for (const summary of response.summaries) { coarse.set(`${summary.x},${summary.z}`, summary); coveredRegions.add(`${Math.floor(summary.x / 32)},${Math.floor(summary.z / 32)}`); states[summary.state] = (states[summary.state] ?? 0) + 1; summaryHash.update(`${summary.x},${summary.z}:${summary.state}:${summary.rgb}\n`); }
      completed += response.summaries.length; requests++; rssPeakSampled = Math.max(rssPeakSampled, process.memoryUsage().rss);
      firstBatchMs ??= performance.now() - start;
      if (!firstAllRegionsSampled && coveredRegions.size === regions.length) firstAllRegionsSampled = { wallMs: performance.now() - start, completed, requests, regions: coveredRegions.size };
      if (requests % 64 === 0) { const sample = { requests, completed, seconds: (performance.now() - start) / 1000, rssBytes: process.memoryUsage().rss }; samples.push(sample); process.stderr.write(JSON.stringify({ strategy, ...sample }) + '\n'); }
    }
  }
  const wallMs = performance.now() - start, cpuUsed = process.cpuUsage(cpu), measuredIO = io.snapshot(); io.restore();
  assert.equal(states[1] ?? 0, completed, 'Generated chunks must decode as ready; failures are not benchmark progress.');
  assert.equal(measuredIO.region.writeCalls + measuredIO.metadata.writeCalls, 0, 'Benchmark must not write source-world files.');
  const result = { schema: 1, strategy, engineRoot, mode: warm ? 'warm-summary-validation' : resume ? 'resumed-summary-generation' : 'cold-summary-generation', node: process.version, platform: process.platform, arch: process.arch, sourceHashes, fixture: manifest, indexedChunks: dimension.chunkCount, indexedRegions: regions.length, indexMs, indexIO, completed, initialCached, newlyCompleted: completed - initialCached, pending: manifest.chunks - completed, requests, validationRequests, stopped, states, wallMs, firstBatchMs, firstAllRegionsSampled, coveredRegions: coveredRegions.size, chunksPerSecond: (warm ? completed : completed - initialCached) / (wallMs / 1000), cpuMs: { user: cpuUsed.user / 1000, system: cpuUsed.system / 1000 }, rssStart, rssPeakSampled, processMaxRSSKiB: process.resourceUsage().maxRSS, reader: reader.stats, io: measuredIO, orderedSummaryHash: summaryHash.digest('hex'), canonicalSummaryHash: digest(Buffer.concat([coarse.states, Buffer.from(coarse.colors.buffer)])), samples,
    methodology: 'Generated fixture only, no user-world reads. Every chunk has distinct NBT coordinates and all 24 sections: nine mixed palettes and fifteen single-air sections. Four repeated terrain variants compress well and are not representative of all real terrain. Cold runs use separate initially empty disk-cache directories and fresh Node processes; filesystem pages are not purged. Batches contain up to 16 chunks. baseline is historical one-chunk-per-region round robin; local finishes each region before moving on; progressive uses the current UI queue to seed actual spatial samples before region-local filling. All strategies maintain the same CompactOverview state; rendering and IPC are not included. Instrumentation counts successful synchronous fs calls and bytes at the JavaScript API boundary, not physical device I/O. Header read counts identify repeated 8-KiB Anvil reads; envelope reads also include per-chunk reads. Peak RSS from process.resourceUsage is process lifetime and includes indexing; sampled RSS is measured between batches. Timing excludes fixture generation and indexing, which are reported separately. First-batch/all-regions-sampled times are engine-plus-queue measurements after indexing, not screen-paint times. No extrapolated completion time, UI performance, app build, or Minecraft gameplay claim.' };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, strategy, completed, pending: result.pending, wallSeconds: wallMs / 1000, indexSeconds: indexMs / 1000, rssMiB: result.processMaxRSSKiB / 1024, region: measuredIO.region, cache: measuredIO.cache, states }));
}

if (process.argv[2] === '--worker') await runWorker(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
else {
  const config = options(process.argv.slice(2));
  fs.mkdirSync(path.join(repo, 'work'), { recursive: true });
  const output = config.output ? path.resolve(config.output) : fs.mkdtempSync(path.join(repo, 'work/performance-overview-'));
  fs.mkdirSync(output, { recursive: true });
  const root = config.fixture ? path.resolve(config.fixture) : path.join(output, 'generated-world');
  let fixture;
  if (config.fixture) { fixture = JSON.parse(fs.readFileSync(path.join(root, 'benchmark-fixture.json'), 'utf8')); assert.equal(fixture.generatedOnly, true); assert.equal(fixture.playable, false); }
  else fixture = makeLargeOverviewWorld(root, { chunks: config.chunks, regions: config.regions, onProgress: progress => process.stderr.write(JSON.stringify({ generating: true, ...progress }) + '\n') });
  console.log(JSON.stringify({ fixture: root, chunks: fixture.chunks, regions: fixture.regions, generationSeconds: fixture.generationSeconds, logicalRegionBytes: fixture.logicalRegionBytes }));
  const results = [];
  for (const strategy of config.strategy === 'all' ? ['baseline', 'local', 'progressive'] : config.strategy === 'both' ? ['baseline', 'local'] : [config.strategy]) {
    const cache = config.resumeCache ? path.resolve(config.resumeCache) : path.join(output, `cache-${strategy}`), phases = config.warm ? [false, true] : [false];
    if (config.resumeCache) { if (!fs.statSync(cache).isDirectory()) throw new Error('Resume cache must exist.'); }
    else if (fs.existsSync(cache)) throw new Error('Output cache already exists; use a fresh output directory for a cold benchmark.');
    for (const warm of phases) {
      const name = `${strategy}${warm ? '-warm' : ''}`, file = path.join(output, `${name}.json`), worker = path.join(output, `${name}-config.json`);
      fs.writeFileSync(worker, JSON.stringify({ root, cache, output: file, strategy, seconds: config.seconds, maxRequests: Number.isFinite(config.maxRequests) ? config.maxRequests : null, warm, resume: Boolean(config.resumeCache), engineRoot: config.engineRoot ? path.resolve(config.engineRoot) : repo }));
      const child = spawnSync(process.execPath, [script, '--worker', worker], { cwd: repo, stdio: 'inherit', timeout: (config.seconds + 180) * 1000 });
      if (child.error || child.status !== 0) throw child.error ?? new Error(`Benchmark worker failed: ${child.status}`);
      results.push(file);
    }
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ generatedOnly: true, fixture, results }, null, 2));
  console.log(JSON.stringify({ evidence: output, results }));
}
