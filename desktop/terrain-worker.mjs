import { parentPort, workerData } from 'node:worker_threads';
import { createTerrainReader } from '../engine/terrain.js';
const reader = createTerrainReader(workerData.world,{cacheDirectory:workerData.cacheDirectory});
parentPort.on('message', ({ id, request }) => {
  try { parentPort.postMessage({ id, result: request.kind==='overview' ? reader.overview(request) : reader.batch(request) }); }
  catch (error) { parentPort.postMessage({ id, error: { code: error.code || 'IO_ERROR', message: error.message } }); }
});
