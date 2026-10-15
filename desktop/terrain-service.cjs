const { Worker } = require('node:worker_threads');
const path = require('node:path');
// Independent, single-flight reader: never occupies the export/protection operation lock.
class TerrainService {
  constructor(world, cacheDirectory) {
    this.world = world;
    this.cacheDirectory=cacheDirectory;
    this.worker = null;
    this.pending = null;
    this.sequence = 0;
  }
  start() {
    if (this.worker) return;
    const world = { root: this.world.root, fingerprint: this.world.fingerprint, metadata: this.world.metadata,
      dimensions: this.world.dimensions.map(({ key, id, path, regions }) => ({ key, id, path, regions:regions.map(({rx,rz,path,sourceStamp,chunks})=>({rx,rz,path,sourceStamp,externals:chunks.filter(c=>c.external).map(({x,z})=>({x,z}))})) })) };
    const worker = this.worker = new Worker(path.join(__dirname, 'terrain-worker.mjs'), { workerData: { world,cacheDirectory:this.cacheDirectory }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    worker.on('message', message => {
      if (this.pending?.id !== message.id) return;
      const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
      message.error ? pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : pending.resolve(message.result);
    });
    worker.on('error', error => this.dispose(error));
    worker.on('exit', () => { if (this.worker === worker) this.dispose(new Error('Terrain worker stopped. Refresh to retry.')); });
  }
  load(request) {
    if (this.pending) return Promise.reject(Object.assign(new Error('Terrain request already active.'), { code: 'TERRAIN_BUSY' }));
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.dispose(new Error('Terrain read exceeded 20 seconds. Refresh to retry.')), 20000);
      this.pending = { id, resolve, reject, timer }; this.worker.postMessage({ id, request });
    });
  }
  dispose(error = new Error('Terrain session changed.')) {
    const worker = this.worker; this.worker = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (worker) worker.terminate();
  }
}
module.exports = { TerrainService };
