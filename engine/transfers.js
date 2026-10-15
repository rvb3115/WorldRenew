import { captureVolume, validateBounds, volumeBlock, indexOf } from './volumes.js';
import { isAir, isFluid, stateKey } from './chunks.js';
import { DIMENSIONS, portalReview } from './dimensions.js';
import { requireThat } from './errors.js';

export const DIFFERENCE = Object.freeze({ unchanged: 0, placed: 1, overwritten: 2, carved: 3, unknown: 4, fluid: 5, airVariant: 6, skippedAir: 7 });
/** Exact-volume, translation-only dry run. Every source air voxel is intentional until reviewed. */
export function previewTransfer(sourceWorld, sourceDimension, sourceBounds, destinationWorld, destinationDimension, anchor, progress = () => {}, options = {}) {
  const sourceId = sourceWorld.dimensions.find(d=>d.key===sourceDimension)?.id, destinationId = destinationWorld.dimensions.find(d=>d.key===destinationDimension)?.id;
  const source = captureVolume(sourceWorld, sourceDimension, sourceBounds, progress);
  return previewCapturedTransfer(source,sourceId,destinationWorld,destinationDimension,anchor,progress,options);
}
export function previewCapturedTransfer(source,sourceId,destinationWorld,destinationDimension,anchor,progress=()=>{},options={}) {
  const airMode = options.airMode ?? 'include';
  requireThat(['include', 'skip'].includes(airMode), 'TRANSFER_AIR_MODE', 'Choose include or skip captured air.');
  const destinationId=destinationWorld.dimensions.find(d=>d.key===destinationDimension)?.id, height=DIMENSIONS[destinationId];
  requireThat(anchor && ['x', 'y', 'z'].every(k => Number.isSafeInteger(anchor[k])), 'TRANSFER_ANCHOR', 'Enter whole-number destination X, Y and Z coordinates.');
  const bounds = { minX: anchor.x, minY: anchor.y, minZ: anchor.z, maxX: anchor.x + source.size.x - 1, maxY: anchor.y + source.size.y - 1, maxZ: anchor.z + source.size.z - 1 };
  validateBounds(bounds);
  const destination = captureVolume(destinationWorld, destinationDimension, bounds, progress);
  // Boundary neighbors are read as a separate, bounded selection. Missing data remains unknown.
  const shellBounds = { minX: bounds.minX - 1, minY: Math.max(bounds.minY - 1,height?.minY??-30000000), minZ: bounds.minZ - 1, maxX: bounds.maxX + 1, maxY: Math.min(bounds.maxY + 1,height?.maxY??30000000), maxZ: bounds.maxZ + 1 };
  let surroundings = null, surroundingsIssue = null;
  try { surroundings = captureVolume(destinationWorld, destinationDimension, shellBounds, progress); }
  catch (error) { surroundingsIssue = error.message; }
  const differences = new Uint8Array(source.voxels.length), counts = { unchanged: 0, placed: 0, overwritten: 0, carved: 0, unknown: 0, fluid: 0, airVariant: 0, skippedAir: 0 };
  const keyCache = volume => volume.palette.map(state => state ? stateKey(state) : null);
  const sk = keyCache(source), dk = keyCache(destination);
  for (let i = 0; i < differences.length; i++) {
    const s = source.palette[source.voxels[i]], d = destination.palette[destination.voxels[i]];
    const kind = !s || !d ? 'unknown' : airMode === 'skip' && isAir(s) ? 'skippedAir' : sk[source.voxels[i]] === dk[destination.voxels[i]] ? 'unchanged' : isAir(s) && !isAir(d) ? 'carved' : isFluid(s) || isFluid(d) ? 'fluid' : isAir(d) && !isAir(s) ? 'placed' : isAir(s) && isAir(d) ? 'airVariant' : 'overwritten';
    differences[i] = DIFFERENCE[kind]; counts[kind]++;
  }
  const boundary = { occupancyMismatchFaces: 0, fluidFaces: 0, unknownFaces: 0, unsupportedBottomBlocks: 0 };
  for (let y = 0; y < source.size.y; y++) for (let z = 0; z < source.size.z; z++) for (let x = 0; x < source.size.x; x++) {
    const directions = [];
    if (x === 0) directions.push([-1, 0, 0]); if (x === source.size.x - 1) directions.push([1, 0, 0]);
    if (y === 0) directions.push([0, -1, 0]); if (y === source.size.y - 1) directions.push([0, 1, 0]);
    if (z === 0) directions.push([0, 0, -1]); if (z === source.size.z - 1) directions.push([0, 0, 1]);
    if (!directions.length) continue;
    const index = indexOf(source.size, x, y, z), capturedState = source.palette[source.voxels[index]];
    const s = airMode === 'skip' && isAir(capturedState) ? destination.palette[destination.voxels[index]] : capturedState;
    for (const [dx, dy, dz] of directions) {
      if(height&&(anchor.y+y+dy<height.minY||anchor.y+y+dy>height.maxY))continue; // Outside build height has no editable neighbor.
      const d = surroundings ? volumeBlock(surroundings, anchor.x + x + dx, anchor.y + y + dy, anchor.z + z + dz) : null;
      if (!s || !d) { boundary.unknownFaces++; continue; }
      if (isAir(s) !== isAir(d)) boundary.occupancyMismatchFaces++;
      if (isFluid(s) || isFluid(d)) boundary.fluidFaces++;
      if (dy === -1 && !isAir(s) && isAir(d)) boundary.unsupportedBottomBlocks++;
    }
  }
  const blockers = ['Export is disabled: entity, biome, block-entity relocation and post-write validation are not implemented.'];
  if (!source.complete) blockers.push('Source selection contains unknown block data or metadata errors.');
  if (!destination.complete) blockers.push('Destination selection contains unknown block data or metadata errors.');
  if (source.dataVersion !== destination.dataVersion) blockers.push('Source and destination DataVersions differ; no conversion adapter is certified.');
  if (boundary.unknownFaces || surroundingsIssue) blockers.push('Some destination boundary data is unavailable. No missing terrain is replaced with air.');
  const portals = portalReview(source, sourceId, destinationId, anchor);
  const warnings = [...portals.warnings];
  const sourceAir = { air: 0, caveAir: 0, voidAir: 0, structureVoid: 0, unknown: 0 };
  const airNames = { 'minecraft:air': 'air', 'minecraft:cave_air': 'caveAir', 'minecraft:void_air': 'voidAir', 'minecraft:structure_void': 'structureVoid' };
  for (const id of source.voxels) { const state = source.palette[id]; if (!state) sourceAir.unknown++; else if (airNames[state.Name]) sourceAir[airNames[state.Name]]++; }
  const effects = { changedBlocks: source.voxels.length - counts.unchanged - counts.skippedAir - counts.unknown, skippedAir: counts.skippedAir, sourceAir };
  if (counts.skippedAir) warnings.push(`${counts.skippedAir.toLocaleString()} captured air blocks are skipped. Destination blocks at those positions stay unchanged; underground rooms may remain filled.`);
  if (sourceAir.structureVoid) warnings.push('Structure-void blocks are preserved as distinct source states, not air or an implicit mask. Copy placement does not support structure-void semantics.');
  if (height && (bounds.minY < height.minY || bounds.maxY > height.maxY)) blockers.push('Placement exceeds the vanilla destination build height.');
  if (counts.carved) warnings.push(`${counts.carved.toLocaleString()} destination blocks would become source air. Inspect every room, tunnel and exterior air volume before any future export.`);
  if (counts.overwritten) warnings.push(`${counts.overwritten.toLocaleString()} occupied destination blocks would be overwritten.`);
  if (boundary.unsupportedBottomBlocks) warnings.push(`${boundary.unsupportedBottomBlocks.toLocaleString()} bottom blocks have air below at the destination. This may be intentional for a sky build.`);
  if (boundary.fluidFaces) warnings.push('Fluids touch the selection boundary; fluid containment needs review.');
  if (Object.values(source.boundaryNonAir).some(n => n > 0)) warnings.push('Non-air blocks touch the source selection edges. Check that foundations, roofs, tunnels and supports are not cut off.');
  warnings.push('Boundary differences are review hints, not proof of a seamless join. Blending and block rotation are not applied.');
  // Each scan checks its own inputs; this is not an atomic multi-world snapshot.
  // Any future writer must revalidate all inputs before acting on a saved preview.
  return { schemaVersion: 1, executable: false, mode: 'exact-volume-translation', airMode, effects, source, destination, context: surroundings, anchor, differences, counts, boundary, portals, blockers, warnings, surroundingsIssue };
}
