import { decodeSection, isAir, stateKey } from './chunks.js';
import { placeableState } from './copy-placement.js';
import { requireThat } from './errors.js';
import { checkTemplateCancellation } from './template-stream.js';
import { compound, field, plain, readTypedNBT, removeField, setField, tag, writeTypedNBT } from './typed-nbt.js';

const MAX_RAW = 32 * 1024 * 1024;
const MAX_SECTIONS = 4096;
const mod16 = value => (value % 16 + 16) % 16;
const bit = (mask, index) => Boolean(mask[index >> 3] & (1 << (index & 7)));
const bytes = node => writeTypedNBT(compound({ value: node }));

function rawRoot(raw) {
  requireThat(Buffer.isBuffer(raw) && raw.length <= MAX_RAW, 'PLACEMENT_SCHEMA', 'Placement requires a terrain record of at most 32 MiB.');
  // Leaves in typed NBT reference their input. Own that input so caller hooks
  // cannot change a prepared record through an aliased Buffer.
  return readTypedNBT(Buffer.from(raw));
}

function terrain(root, x, z) {
  requireThat(field(root, 'DataVersion')?.type === 3 && plain(field(root, 'DataVersion')) === 4903,
    'PLACEMENT_VERSION', 'Template placement supports DataVersion 4903 terrain only.');
  requireThat(field(root, 'xPos')?.type === 3 && field(root, 'zPos')?.type === 3 &&
    plain(field(root, 'xPos')) === x && plain(field(root, 'zPos')) === z,
  'PLACEMENT_POSITION', 'Terrain coordinates disagree with the requested chunk.');
  requireThat(['minecraft:full', 'full'].includes(plain(field(root, 'Status'))),
    'PLACEMENT_SCHEMA', 'Template placement requires fully generated terrain.');
  const sections = field(root, 'sections');
  requireThat(sections?.type === 9 && sections.elementType === 10 && sections.value.length <= MAX_SECTIONS,
    'PLACEMENT_SCHEMA', 'Unsupported typed section list.');
  const byY = new Map();
  for (const section of sections.value) {
    const y = field(section, 'Y');
    requireThat(y && [1, 2, 3].includes(y.type) && Number.isSafeInteger(y.value) && !byY.has(y.value),
      'PLACEMENT_SECTIONS', 'Duplicate or invalid terrain section.');
    byY.set(y.value, section);
  }
  for (const name of ['block_entities', 'block_ticks', 'fluid_ticks']) {
    const list = field(root, name);
    requireThat(list?.type === 9 && (!list.value.length || list.elementType === 10) &&
      list.value.every(value => ['x', 'y', 'z'].every(key => Number.isSafeInteger(plain(field(value, key))))),
    'PLACEMENT_METADATA', 'Terrain attachments have missing or malformed coordinates.');
  }
  for (const name of ['below_zero_retrogen', 'UpgradeData', 'blending_data']) {
    requireThat(!field(root, name), 'PLACEMENT_UPGRADE', 'Chunks with pending upgrade or terrain blending data are not supported.');
  }
  const updates = field(root, 'PostProcessing');
  requireThat(!updates || (updates.type === 9 && updates.value.every(value => value.type === 9 && value.value.length === 0)),
    'PLACEMENT_UPDATES', 'Chunks with pending or unknown post-processing updates are not supported.');
  return byY;
}

function sectionData(section) {
  const states = field(section, 'block_states');
  requireThat(states?.type === 10, 'PLACEMENT_UNKNOWN', 'Selected terrain has no known block states. Unknown terrain cannot become air.');
  const palette = field(states, 'palette'), data = field(states, 'data');
  requireThat(palette?.type === 9 && palette.elementType === 10 && (!data || data.type === 12),
    'PLACEMENT_SCHEMA', 'Placement requires the existing compound palette and NBT long encoding.');
  return { states, typedPalette: palette, ...decodeSection(plain(section)) };
}

// A read adapter can normalize unknown fields; a write adapter cannot silently
// discard them or presume their meaning. Untouched destination palette entries
// are retained verbatim, including entries that currently have no references.
function ordinaryEntry(entry) {
  if (entry?.type !== 10 || entry.value.some(value => !['Name', 'Properties'].includes(value.name))) return false;
  return legacyEntry(entry);
}
function legacyEntry(entry) {
  if (entry?.type !== 10 || field(entry, 'id') || field(entry, 'properties') || field(entry, '')) return false;
  const name = field(entry, 'Name'), properties = field(entry, 'Properties');
  return name?.type === 8 && (!properties || (properties.type === 10 && properties.value.every(value => value.type === 8)));
}
function ordinaryStorage(states) {
  return states.value.every(value => ['palette', 'data'].includes(value.name));
}

function attachmentsOutside(root, x, z, masks) {
  for (const name of ['block_entities', 'block_ticks', 'fluid_ticks']) {
    for (const record of field(root, name).value) {
      const px = plain(field(record, 'x')), py = plain(field(record, 'y')), pz = plain(field(record, 'z'));
      if (Math.floor(px / 16) !== x || Math.floor(pz / 16) !== z) continue;
      const mask = masks.get(Math.floor(py / 16));
      requireThat(!mask || !bit(mask, mod16(py) * 256 + mod16(pz) * 16 + mod16(px)),
        'PLACEMENT_ATTACHMENTS', 'Selected cells touch a block entity or scheduled update; relocation is unsupported.');
    }
  }
}

function packed(indices, paletteLength) {
  const bits = Math.max(4, Math.ceil(Math.log2(paletteLength))), per = Math.floor(64 / bits), words = [];
  for (let start = 0; start < 4096; start += per) {
    let word = 0n;
    for (let i = 0; i < per && start + i < 4096; i++) word |= BigInt(indices[start + i]) << BigInt(i * bits);
    words.push(BigInt.asIntN(64, word).toString());
  }
  return tag(12, words);
}

// Clone only compound containers that the writer changes. Leaf payloads and all
// unrelated subtrees retain the exact typed representation, including NaN bits.
function originalView(root) {
  const view = { ...root, value: [...root.value] }, sections = field(root, 'sections');
  setField(view, 'sections', { ...sections, value: sections.value.map(section => ({ ...section, value: [...section.value] })) });
  return view;
}
function unrelatedBytes(root, modified) {
  const view = originalView(root);
  removeField(view, 'isLightOn');
  if (modified.size) removeField(view, 'Heightmaps');
  for (const section of field(view, 'sections').value) {
    removeField(section, 'BlockLight'); removeField(section, 'SkyLight');
    if (modified.has(plain(field(section, 'Y')))) removeField(section, 'block_states');
  }
  return writeTypedNBT(view);
}

function verifyPrepared(before, raw, changedSections, x, z) {
  const after = readTypedNBT(raw), sections = terrain(after, x, z);
  requireThat(unrelatedBytes(before, changedSections).equals(unrelatedBytes(after, changedSections)),
    'PLACEMENT_VERIFY', 'Unrelated typed terrain metadata changed.');
  requireThat(field(after, 'isLightOn')?.type === 1 && plain(field(after, 'isLightOn')) === 0 &&
    (!changedSections.size || !field(after, 'Heightmaps')) &&
    [...sections.values()].every(section => !field(section, 'BlockLight') && !field(section, 'SkyLight')),
  'PLACEMENT_VERIFY', 'Derived terrain data was not invalidated safely.');
  for (const [y, expected] of changedSections) {
    const actual = sectionData(sections.get(y));
    requireThat(bytes(actual.typedPalette).equals(bytes(tag(9, expected.entries, 10))),
      'PLACEMENT_VERIFY', 'Typed palette entries changed unexpectedly.');
    // Expected indices begin as an exact copy of the destination and are only
    // assigned for selected, non-skipped cells. This checks all 4096 cells,
    // including exclusions and every skipped source-air cell.
    requireThat(actual.indices.every((value, index) => value === expected.indices[index]),
      'PLACEMENT_VERIFY', 'Selected or excluded terrain cells changed unexpectedly.');
  }
}

/**
 * Pure, bounded per-destination-chunk preparation. Patches are consumed once,
 * sequentially: {chunk:{x,z,sections:[{y,mask:Buffer(512)}],records:{region}},
 * offset:{x,y,z}}. At most four unique source chunks share one integer offset.
 *
 * World/version/dimension, entity/POI, protection, reviewed-input and owned-copy
 * gates remain the caller's responsibility. This helper additionally enforces
 * terrain schema, touched-state allowlists and block-entity/tick exclusions.
 * It writes no files and verifies complete affected sections plus unrelated
 * typed metadata before returning. Cancellation returns no prepared output.
 */
export function rewriteTemplateChunk(raw, x, z, patchesIterable, options = {}) {
  const { airMode = 'include' } = options;
  requireThat(['include', 'skip'].includes(airMode), 'TRANSFER_AIR_MODE', 'Choose include or skip for source air.');
  requireThat(Number.isSafeInteger(x) && Number.isSafeInteger(z) && Number.isSafeInteger(x * 16 + 15) && Number.isSafeInteger(z * 16 + 15),
    'PLACEMENT_POSITION', 'Destination chunk coordinates are invalid.');
  requireThat(patchesIterable && typeof patchesIterable[Symbol.iterator] === 'function', 'PLACEMENT_PATCH', 'Provide iterable source patches.');
  checkTemplateCancellation(options);
  const root = rawRoot(raw), destination = terrain(root, x, z), before = originalView(root);
  const prepared = new Map(), changedSections = new Map(), selected = new Map(), sourceChunks = new Set();
  let commonOffset, changedBlocks = 0;
  for (const patch of patchesIterable) {
    checkTemplateCancellation(options);
    requireThat(sourceChunks.size < 4, 'PLACEMENT_PATCH', 'A translated destination chunk can receive at most four source chunks.');
    const chunk = patch?.chunk, offset = patch?.offset;
    requireThat(chunk && Number.isSafeInteger(chunk.x) && Number.isSafeInteger(chunk.z) &&
      Number.isSafeInteger(chunk.x * 16 + 15) && Number.isSafeInteger(chunk.z * 16 + 15) &&
      offset && ['x', 'y', 'z'].every(key => Number.isSafeInteger(offset[key])),
    'PLACEMENT_PATCH', 'Source patch coordinates or translation are invalid.');
    const translation = { x: offset.x, y: offset.y, z: offset.z }, sourceId = `${chunk.x},${chunk.z}`;
    requireThat(!sourceChunks.has(sourceId) && (!commonOffset || ['x', 'y', 'z'].every(key => commonOffset[key] === translation[key])),
      'PLACEMENT_PATCH', 'Source patches must be unique chunks with one constant translation.');
    sourceChunks.add(sourceId); commonOffset ??= translation;
    requireThat(Array.isArray(chunk.sections) && chunk.sections.length <= MAX_SECTIONS, 'PLACEMENT_PATCH', 'Unsupported source section selection.');
    const source = rawRoot(chunk.records?.region), sourceSections = terrain(source, chunk.x, chunk.z), masks = new Map();
    for (const selection of chunk.sections) {
      checkTemplateCancellation(options);
      requireThat(Number.isSafeInteger(selection?.y) && !masks.has(selection.y) &&
        Buffer.isBuffer(selection.mask) && selection.mask.length === 512,
      'PLACEMENT_MASK', 'Source masks must be unique sections containing exactly 4096 bits.');
      const mask = Buffer.from(selection.mask); masks.set(selection.y, mask);
      const sourceSection = sourceSections.get(selection.y);
      requireThat(sourceSection, 'PLACEMENT_UNKNOWN', 'A selected source section is missing. Unknown terrain cannot become air.');
      const sourceData = sectionData(sourceSection);
      requireThat(ordinaryStorage(sourceData.states), 'PLACEMENT_UNKNOWN', 'Source block-state extensions require a validated placement adapter.');
      for (let index = 0; index < 4096; index++) {
        if ((index & 255) === 0) checkTemplateCancellation(options);
        if (!bit(mask, index)) continue;
        const sx = chunk.x * 16 + index % 16, sy = selection.y * 16 + Math.floor(index / 256), sz = chunk.z * 16 + Math.floor(index / 16) % 16;
        const px = sx + translation.x, py = sy + translation.y, pz = sz + translation.z;
        requireThat([sx, sy, sz, px, py, pz].every(Number.isSafeInteger), 'PLACEMENT_POSITION', 'Translated coordinates exceed exact integer precision.');
        const sourceState = sourceData.palette[sourceData.indices[index]];
        const typedEntry = sourceData.typedPalette.value[sourceData.indices[index]];
        requireThat(placeableState(sourceState) && ordinaryEntry(typedEntry),
          'PLACEMENT_STATE', 'Selected source states or palette extensions require a validated placement adapter.');
        if (Math.floor(px / 16) !== x || Math.floor(pz / 16) !== z) continue;
        const y = Math.floor(py / 16), at = mod16(py) * 256 + mod16(pz) * 16 + mod16(px), section = destination.get(y);
        requireThat(section, 'PLACEMENT_UNKNOWN', 'A selected destination section is missing. Unknown terrain cannot become air.');
        if (!prepared.has(y)) {
          const data = sectionData(section), entries = [...data.typedPalette.value], lookup = new Map();
          data.palette.forEach((state, id) => { if (ordinaryEntry(entries[id]) && !lookup.has(stateKey(state))) lookup.set(stateKey(state), id); });
          prepared.set(y, { ...data, entries, lookup, legacyEncoding: entries.every(legacyEntry) });
        }
        const data = prepared.get(y);
        if (!selected.has(y)) selected.set(y, Buffer.alloc(512));
        const selectionMask = selected.get(y);
        requireThat(!bit(selectionMask, at), 'PLACEMENT_PATCH', 'Source patches overlap a destination cell.');
        selectionMask[at >> 3] |= 1 << (at & 7);
        if (airMode === 'skip' && isAir(sourceState)) continue;
        const oldId = data.indices[at], oldState = data.palette[oldId];
        if (stateKey(oldState) === stateKey(sourceState)) continue;
        requireThat(placeableState(oldState) && ordinaryEntry(data.entries[oldId]) && ordinaryStorage(data.states) && data.legacyEncoding,
          'PLACEMENT_STATE', 'Replacing destination states or block-state extensions requires a validated placement adapter.');
        const key = stateKey(sourceState);
        if (!data.lookup.has(key)) {
          requireThat(data.entries.length < 4096, 'PLACEMENT_PALETTE', 'Palette capacity would require discarding retained entries.');
          data.lookup.set(key, data.entries.length); data.entries.push(typedEntry); data.palette.push(sourceState);
        }
        data.indices[at] = data.lookup.get(key); changedSections.set(y, data); changedBlocks++;
      }
    }
    attachmentsOutside(source, chunk.x, chunk.z, masks);
  }
  checkTemplateCancellation(options);
  attachmentsOutside(root, x, z, selected);
  for (const [y, data] of changedSections) {
    const states = { ...data.states, value: [...data.states.value] };
    setField(states, 'palette', tag(9, data.entries, 10));
    if (data.entries.length > 1) setField(states, 'data', packed(data.indices, data.entries.length));
    else removeField(states, 'data');
    setField(destination.get(y), 'block_states', states);
  }
  if (changedBlocks) removeField(root, 'Heightmaps');
  setField(root, 'isLightOn', tag(1, 0));
  for (const section of destination.values()) { removeField(section, 'BlockLight'); removeField(section, 'SkyLight'); }
  const output = writeTypedNBT(root);
  requireThat(output.length <= MAX_RAW, 'PLACEMENT_SCHEMA', 'Prepared terrain exceeds the 32 MiB record limit.');
  verifyPrepared(before, output, changedSections, x, z);
  checkTemplateCancellation(options);
  return { raw: output, changedBlocks, changed: changedBlocks > 0 };
}
