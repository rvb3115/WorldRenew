import {templateWorkspace,editTemplateSelection,sourceTemplateSlice,captureWorkspaceTemplate} from '../engine/template-workspace.js';
import {templateSchema,openTemplatePreview,templatePreviewSlice} from '../engine/template-preview.js';
import {previewTemplatePlacement,createTemplatePlacedCopy} from '../engine/template-placement.js';
import {importTemplateStream,exportTemplateStream,listTemplatesStream} from '../engine/template-stream-library.js';
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
const templateOptions={worlds:workerData.worlds??[],onProgress:progress,shouldCancel:()=>workerData.cancelFlag?Atomics.load(new Int32Array(workerData.cancelFlag),0)!==0:false};
const openPortable=(file,id)=>templateSchema(file)===2?openTemplatePreview(workerData.previewDirectory,file,templateOptions):openTemplate(workerData.directory,id);
try {
  let result;
  switch (workerData.action) {
    case 'template-list': result = listTemplatesStream(workerData.directory,{...workerData.options,...templateOptions}); break;
    case 'template-import': {const imported=importTemplateStream(workerData.directory,workerData.file,templateOptions);result=openPortable(imported.file,imported.id);break;}
    case 'template-open': {const {templatePath}=await import('../engine/template-library.js');result=openPortable(templatePath(workerData.directory,workerData.id),workerData.id);break;}
    case 'template-export': result = exportTemplateStream(workerData.file,workerData.destination,templateOptions); break;
    case 'template-workspace': result=templateWorkspace(workerData.selectionDirectory,workerData.world,workerData.dimension);break;
    case 'template-edit': result=editTemplateSelection(workerData.selectionDirectory,workerData.world,workerData.dimension,workerData.edit);break;
    case 'template-source-slice': result=sourceTemplateSlice(workerData.selectionDirectory,workerData.world,workerData.dimension,workerData.request,templateOptions);break;
    case 'template-preview-slice': result=templatePreviewSlice(workerData.previewDirectory,workerData.context,workerData.request,templateOptions);break;
    case 'template-placement-preview': result=previewTemplatePlacement(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,{...workerData.options,...templateOptions});break;
    case 'template-placement-copy': result=createTemplatePlacedCopy(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,workerData.parent,{...workerData.options,...templateOptions});break;
    case 'template-capture-sparse': {const saved=captureWorkspaceTemplate(workerData.selectionDirectory,workerData.directory,workerData.world,workerData.dimension,workerData.capture,templateOptions);result=openPortable(saved.file,saved.id);break;}
    case 'template-save': result = saveTemplate(workerData.directory, workerData.name, captureBuildArchive(workerData.world, workerData.dimension, workerData.bounds, progress, workerData.expectedDigest), workerData.worlds); break;
    case 'archive-save': result=saveBuildFile(workerData.file,captureBuildArchive(workerData.world,workerData.dimension,workerData.bounds,progress,workerData.expectedDigest),workerData.worlds);break;
    case 'archive-open': {const b=readBuildFile(workerData.file);result={file:workerData.file,digest:b.digest,volume:b.volume,summary:b.summary};break;}
    case 'archive-preview': result=previewBuildFile(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,progress,workerData.protection,workerData.options);break;
    case 'archive-place': result=createPlacedCopy(workerData.file,workerData.destination,workerData.destinationDimension,workerData.anchor,workerData.parent,workerData.options,progress);break;
    case 'textures': result = textureBundle(workerData.file, workerData.palette, workerData.fallbackFile); break;
    case 'regeneration-review': result = createRegenerationReview(workerData.world, workerData.selected, workerData.protection, workerData.options, progress); break;
    case 'regeneration-save': result = saveRegenerationReview(workerData.directory, workerData.world, workerData.review, progress); break;
    case 'regeneration-export': result = createRegeneratedCopy(workerData.world, workerData.review, workerData.parent, workerData.options, progress); break;
    case 'inspect': result = inspectWorld(workerData.folder, progress); break;
    case 'copy': result = createVerifiedCopy(workerData.folder, workerData.parent, workerData.options, progress); break;
    case 'capture': result = captureVolume(workerData.world, workerData.dimension, workerData.bounds, progress); break;
    case 'transfer': result = previewTransfer(workerData.world, workerData.dimension, workerData.bounds, workerData.destination, workerData.destinationDimension, workerData.anchor, progress, workerData.options); break;
    default: throw new Error('Unknown worker operation.');
  }
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: { code: error.code || 'IO_ERROR', message: error.message } }); }
