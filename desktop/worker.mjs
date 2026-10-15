import { importTemplate, saveTemplate, openTemplate, exportTemplate, listTemplates } from '../engine/template-library.js';
import { createRegenerationReview, saveRegenerationReview } from '../engine/regeneration.js';
import { createRegeneratedCopy } from '../engine/regeneration-export.js';
import {captureBuildArchive,saveBuildFile,readBuildFile} from '../engine/build-archive.js';
import {previewBuildFile,createPlacedCopy} from '../engine/copy-placement.js';
import { textureBundle } from '../engine/assets.js';
import { parentPort, workerData } from 'node:worker_threads';
import { inspectWorld } from '../engine/world.js';
import { createVerifiedCopy } from '../engine/safety.js';
import { captureVolume } from '../engine/volumes.js';
import { previewTransfer } from '../engine/transfers.js';
let last = 0;
const progress = value => { if (Date.now() - last > 100) { last = Date.now(); parentPort.postMessage({ progress: value }); } };
try {
  let result;
  switch (workerData.action) {
    case 'template-list': result = listTemplates(workerData.directory, workerData.options, workerData.worlds); break;
    case 'template-import': result = importTemplate(workerData.directory, workerData.file, workerData.worlds); break;
    case 'template-open': result = openTemplate(workerData.directory, workerData.id); break;
    case 'template-export': result = exportTemplate(workerData.file, workerData.destination, workerData.worlds); break;
    case 'template-save': result = saveTemplate(workerData.directory, workerData.name, captureBuildArchive(workerData.world, workerData.dimension, workerData.bounds, progress, workerData.expectedDigest), workerData.worlds); break;
    case 'archive-save': result=saveBuildFile(workerData.file,captureBuildArchive(workerData.world,workerData.dimension,workerData.bounds,progress,workerData.expectedDigest),workerData.worlds);break;
    case 'archive-open': {const b=readBuildFile(workerData.file);result={file:workerData.file,digest:b.digest,volume:b.volume,summary:b.summary};break;}
    case 'archive-preview': result=previewBuildFile(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,progress,workerData.protection);break;
    case 'archive-place': result=createPlacedCopy(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,workerData.parent,workerData.options,progress);break;
    case 'textures': result = textureBundle(workerData.file, workerData.palette, workerData.fallbackFile); break;
    case 'regeneration-review': result = createRegenerationReview(workerData.world, workerData.selected, workerData.protection, workerData.options, progress); break;
    case 'regeneration-save': result = saveRegenerationReview(workerData.directory, workerData.world, workerData.review, progress); break;
    case 'regeneration-export': result = createRegeneratedCopy(workerData.world, workerData.review, workerData.parent, workerData.options, progress); break;
    case 'inspect': result = inspectWorld(workerData.folder, progress); break;
    case 'copy': result = createVerifiedCopy(workerData.folder, workerData.parent, workerData.options, progress); break;
    case 'capture': result = captureVolume(workerData.world, workerData.dimension, workerData.bounds, progress); break;
    case 'transfer': result = previewTransfer(workerData.world, workerData.dimension, workerData.bounds, workerData.destination, workerData.destinationDimension, workerData.anchor, progress); break;
    default: throw new Error('Unknown worker operation.');
  }
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: { code: error.code || 'IO_ERROR', message: error.message } }); }
