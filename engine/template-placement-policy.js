import { placeableState } from './copy-placement.js';
import { validEntity } from './build-archive.js';
import { decodeSection } from './chunks.js';
import { DIMENSIONS } from './dimensions.js';
import { parseNBT } from './nbt.js';
import { requireThat } from './errors.js';
import { TEMPLATE_LIMITS, checkTemplateCancellation } from './template-stream.js';

const LIMIT = 30000000;
const ATTACHMENTS = ['block_entities', 'block_ticks', 'fluid_ticks'];
const destinationViews = new WeakMap();
const object = value => value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
const integer = value => Number.isSafeInteger(value);
const local = value => (value % 16 + 16) % 16;
const key = (x, y, z) => `${x},${y},${z}`;
const ownChunk = (x, z, cx, cz) => Math.floor(x / 16) === cx && Math.floor(z / 16) === cz;

/** Header checks deliberately impose no total-cell or extent budget. */
export function validateTemplatePlacementHeader(header, destination, dimensionKey, anchor, options = {}) {
  requireThat(header?.format === 'WorldRenew.build' && header.schema === 2, 'PLACEMENT_TEMPLATE', 'Unsupported template placement header.');
  const source = header.source, dimension = destination?.dimensions?.find(d => d.key === dimensionKey);
  requireThat(source?.version === '26.2' && source.dataVersion === 4903 && destination?.metadata?.version === '26.2' && destination.metadata.dataVersion === 4903,
    'PLACEMENT_VERSION', 'Copy placement supports Java 26.2 / DataVersion 4903 only. Other versions need a validated placement adapter.');
  requireThat(dimension && Object.hasOwn(DIMENSIONS, dimension.id) && source.dimensionId === dimension.id,
    'PLACEMENT_DIMENSION', 'Copy placement requires the same vanilla dimension in both worlds.');
  const airMode = options.airMode ?? 'include';
  requireThat(['include', 'skip'].includes(airMode), 'TRANSFER_AIR_MODE', 'Choose include or skip captured air.');
  requireThat(anchor && ['x', 'y', 'z'].every(k => integer(anchor[k])), 'TRANSFER_ANCHOR', 'Enter whole-number destination X, Y and Z coordinates.');
  const bounds = {}, offset = {};
  for (const axis of ['X', 'Y', 'Z']) {
    const min = source.bounds?.[`min${axis}`], max = source.bounds?.[`max${axis}`], lower = axis.toLowerCase();
    requireThat(integer(min) && integer(max) && min >= -LIMIT && max <= LIMIT && min <= max, 'PLACEMENT_BOUNDS', 'Invalid source template bounds.');
    bounds[`min${axis}`] = anchor[lower]; bounds[`max${axis}`] = anchor[lower] + max - min;
    requireThat(integer(bounds[`max${axis}`]) && bounds[`min${axis}`] >= -LIMIT && bounds[`max${axis}`] <= LIMIT,
      'PLACEMENT_BOUNDS', 'Translated template bounds exceed supported world coordinates.');
    offset[lower] = anchor[lower] - min;
  }
  const height = DIMENSIONS[dimension.id];
  requireThat(bounds.minY >= height.minY && bounds.maxY <= height.maxY, 'PLACEMENT_HEIGHT', 'Placement exceeds the vanilla destination build height.');
  const warnings = ['Experimental building-block copy only: destination biomes are retained; entities, inventories, portals, fluids, redstone, rotation and blending are not placed. Minecraft must rebuild lighting and heightmaps on first load. Game-load certification is still pending.'];
  if (!source.configuration) warnings.push('This template has no recorded feature/datapack provenance. Supported block adapters still apply; no configuration is inferred.');
  return { dimension, offset, bounds, airMode, warnings };
}

function record(value, store) {
  if (value === null) { requireThat(store !== 'region', 'PLACEMENT_UNKNOWN', 'Unknown terrain cannot be placed or replaced with air.'); return null; }
  const raw = Buffer.isBuffer(value) ? value : value?.raw;
  requireThat(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= TEMPLATE_LIMITS.record,
    'PLACEMENT_METADATA', `Missing, invalid or oversized ${store} record.`);
  // Reparse the exact raw evidence, never trust a caller-supplied decoded view.
  const nbt = parseNBT(raw);
  requireThat(nbt.DataVersion === 4903 || (store === 'poi' && nbt.DataVersion === undefined), 'PLACEMENT_VERSION', 'All placement chunk records must match DataVersion 4903.');
  return { raw, nbt };
}

function terrain(value, x, z, destination) {
  const result = record(value, 'region'), nbt = result.nbt;
  requireThat(integer(x) && integer(z) && nbt.xPos === x && nbt.zPos === z && ['full', 'minecraft:full'].includes(nbt.Status),
    'PLACEMENT_UNKNOWN', 'Placement requires complete terrain chunks at their recorded coordinates.');
  requireThat(Array.isArray(nbt.sections) && nbt.sections.every(s => object(s) && integer(s.Y)) && new Set(nbt.sections.map(s => s.Y)).size === nbt.sections.length,
    'PLACEMENT_SECTIONS', 'Duplicate or invalid placement sections.');
  for (const field of ATTACHMENTS) requireThat(Array.isArray(nbt[field]) && nbt[field].every(p => object(p) && ['x', 'y', 'z'].every(k => integer(p[k]))),
    'PLACEMENT_METADATA', `Placement ${field} records have missing or invalid coordinates.`);
  if (destination) {
    requireThat(!['below_zero_retrogen', 'UpgradeData', 'blending_data'].some(k => Object.hasOwn(nbt, k)),
      'PLACEMENT_UPGRADE', 'Chunks with pending upgrade or terrain blending data are not supported.');
    if (nbt.PostProcessing !== undefined) {
      requireThat(Array.isArray(nbt.PostProcessing) && nbt.PostProcessing.every(list => Array.isArray(list) && list.every(integer)),
        'PLACEMENT_UPDATES', 'Malformed destination post-processing updates.');
      requireThat(nbt.PostProcessing.every(list => list.length === 0), 'PLACEMENT_UPDATES', 'Chunks with pending post-processing updates are not supported.');
    }
  }
  return result;
}

function* entityPoints(entity) {
  yield { x: Math.floor(entity.Pos[0]), y: Math.floor(entity.Pos[1]), z: Math.floor(entity.Pos[2]) };
  if (['TileX', 'TileY', 'TileZ'].some(k => Object.hasOwn(entity, k))) {
    requireThat(['TileX', 'TileY', 'TileZ'].every(k => Number.isFinite(entity[k])), 'PLACEMENT_ENTITIES', 'Entity anchor coordinates are malformed.');
    yield { x: Math.floor(entity.TileX), y: Math.floor(entity.TileY), z: Math.floor(entity.TileZ) };
  }
  for (const passenger of entity.Passengers ?? []) yield* entityPoints(passenger);
}

function entities(value, x, z) {
  const result = record(value, 'entities'); if (!result) return null;
  const nbt = result.nbt;
  requireThat(Array.isArray(nbt.Entities) && nbt.Entities.every(validEntity) && Array.isArray(nbt.Position) && nbt.Position.length === 2 && nbt.Position[0] === x && nbt.Position[1] === z,
    'PLACEMENT_ENTITIES', 'Placement entity records or their chunk position are malformed.');
  for (const entity of nbt.Entities) for (const point of entityPoints(entity)) void point;
  return result;
}

function poi(value) {
  const result = record(value, 'poi'); if (!result) return null;
  requireThat(object(result.nbt.Sections) && Object.values(result.nbt.Sections).every(s => object(s) && Array.isArray(s.Records)),
    'PLACEMENT_POI', 'Unsupported POI sections or records.');
  for (const point of poiPoints(result.nbt)) void point;
  return result;
}

function* poiPoints(nbt) {
  if (!nbt) return;
  for (const section of Object.values(nbt.Sections)) for (const item of section.Records) {
    requireThat(object(item) && typeof item.pos === 'string' && /^-?\d{1,19}$/.test(item.pos), 'PLACEMENT_POI', 'POI position must be an exact signed NBT long.');
    const packed = BigInt(item.pos);
    requireThat(packed >= -(1n << 63n) && packed < (1n << 63n), 'PLACEMENT_POI', 'POI position is outside signed NBT long range.');
    yield { x: Number(BigInt.asIntN(26, packed >> 38n)), y: Number(BigInt.asIntN(12, packed)), z: Number(BigInt.asIntN(26, packed >> 12n)) };
  }
}

function* attachmentPoints(view) {
  for (const field of ATTACHMENTS) for (const point of view.region.nbt[field]) yield { point, kind: field };
  for (const entity of view.entities?.nbt.Entities ?? []) for (const point of entityPoints(entity)) yield { point, kind: 'entities' };
  for (const point of poiPoints(view.poi?.nbt)) yield { point, kind: 'poi' };
}

/** Checks the complete raw records while interpreting selection exclusively through native masks. */
export function validateTemplateSourceChunk(chunk, options = {}) {
  checkTemplateCancellation(options);
  requireThat(object(chunk) && integer(chunk.x) && integer(chunk.z) && Math.abs(chunk.x) <= 1875000 && Math.abs(chunk.z) <= 1875000 && object(chunk.records),
    'PLACEMENT_TEMPLATE', 'Invalid source template chunk.');
  const { x, z } = chunk;
  const view = { x, z, region: terrain(chunk.records.region, x, z, false), entities: entities(chunk.records.entities, x, z), poi: poi(chunk.records.poi), records: chunk.records };
  requireThat(Array.isArray(chunk.sections) && chunk.sections.length > 0 && chunk.sections.length <= TEMPLATE_LIMITS.sections, 'PLACEMENT_MASK', 'Missing or excessive selection masks.');
  const masks = new Map(), sections = new Map(view.region.nbt.sections.map(s => [s.Y, s]));
  let previous = -Infinity;
  for (const selected of chunk.sections) {
    requireThat(object(selected) && integer(selected.y) && Math.abs(selected.y) <= 1875000 && selected.y > previous && Buffer.isBuffer(selected.mask) && selected.mask.length === 512 && selected.mask.some(Boolean),
      'PLACEMENT_MASK', 'Selection masks must be nonempty, valid and ordered by unique section Y.');
    previous = selected.y; masks.set(selected.y, Buffer.from(selected.mask));
  }
  view.contains = (px, py, pz) => {
    if (![px, py, pz].every(integer) || !ownChunk(px, pz, x, z)) return false;
    const mask = masks.get(Math.floor(py / 16)), index = local(py) * 256 + local(pz) * 16 + local(px);
    return Boolean(mask && (mask[index >> 3] & 1 << (index & 7)));
  };
  view.blocks = function* () {
    for (const [sy, mask] of masks) {
      checkTemplateCancellation(options);
      requireThat(sections.get(sy)?.block_states, 'PLACEMENT_UNKNOWN', 'Selected source terrain is unknown; it cannot become air.');
      const decoded = decodeSection(sections.get(sy));
      for (let index = 0; index < 4096; index++) if (mask[index >> 3] & 1 << (index & 7)) {
        const state = decoded.palette[decoded.indices[index]];
        requireThat(placeableState(state), 'PLACEMENT_SOURCE_BLOCK', `Source block ${state?.Name ?? '(unknown)'} needs a validated placement adapter.`);
        yield { x: x * 16 + index % 16, y: sy * 16 + (index >> 8), z: z * 16 + ((index >> 4) & 15), state };
      }
    }
  };
  // Validate the entire frame before exposing its first cell to a writer, but
  // retain only raw records/masks and one temporary decoded section at a time.
  for (const block of view.blocks()) void block;
  for (const { point, kind } of attachmentPoints(view)) {
    requireThat(ownChunk(point.x, point.z, x, z), 'PLACEMENT_SOURCE_CROSS_CHUNK', `Source ${kind} coordinates extend outside their owning chunk; cross-chunk attachment selection is not supported.`);
    requireThat(!view.contains(point.x, point.y, point.z), 'PLACEMENT_SOURCE_ATTACHMENTS', 'Selected source cells contain block entities, scheduled updates, entities or POI that need a relocation adapter.');
  }
  return view;
}

/** Each view is bounded to one terrain chunk and its supporting records. */
export function validateTemplateDestinationChunk(region, entityRecord, poiRecord, x, z) {
  const view = { x, z, region: terrain(region, x, z, true), entities: entities(entityRecord, x, z), poi: poi(poiRecord) };
  const sections = new Map(view.region.nbt.sections.map(s => [s.Y, s]));
  // Neighbor checks alternate between sections at their shared boundary. Keep
  // an LRU large enough for vanilla height while bounding unusual chunk data.
  const decodedSections = new Map();
  view.block = (px, py, pz) => {
    requireThat([px, py, pz].every(integer) && ownChunk(px, pz, x, z), 'PLACEMENT_COORDINATES', 'Requested destination cell is outside this chunk.');
    const sy = Math.floor(py / 16);
    let decoded = decodedSections.get(sy);
    if (decoded) decodedSections.delete(sy);
    else {
      requireThat(sections.get(sy)?.block_states, 'PLACEMENT_UNKNOWN', 'Selected destination terrain is unknown; it cannot become air.');
      decoded = decodeSection(sections.get(sy));
    }
    decodedSections.set(sy, decoded);
    if (decodedSections.size > 32) decodedSections.delete(decodedSections.keys().next().value);
    return decoded.palette[decoded.indices[local(py) * 256 + local(pz) * 16 + local(px)]];
  };
  // Keep positional occupancy independent of any caller edits to parsed NBT.
  const occupied = new Map();
  for (const { point, kind } of attachmentPoints(view)) occupied.set(key(point.x, point.y, point.z), { ...point, kind });
  destinationViews.set(view, occupied);
  return view;
}

/** Test every supporting record against a sparse target predicate (also used for neighboring chunks). */
export function assertDestinationAttachmentsClear(view, contains) {
  requireThat(destinationViews.has(view) && typeof contains === 'function', 'PLACEMENT_METADATA', 'Invalid destination placement view or selection predicate.');
  for (const point of destinationViews.get(view).values()) requireThat(!contains(point.x, point.y, point.z), 'PLACEMENT_DESTINATION_ATTACHMENTS', `Selected destination cells overlap ${point.kind}. Choose an unoccupied area.`);
}

/** Attachments remain protected even when a selected air cell will be skipped. */
export function assertDestinationCellWritable(view, x, y, z) {
  requireThat(destinationViews.has(view), 'PLACEMENT_METADATA', 'Invalid destination placement view.');
  requireThat(!destinationViews.get(view).has(key(x, y, z)), 'PLACEMENT_DESTINATION_ATTACHMENTS', 'Selected destination cell contains block entities, scheduled updates, entities or POI.');
  return view.block(x, y, z);
}
