import { requireThat } from './errors.js';

export const SELECTION_COORDINATE_LIMIT = 30_000_000;
export const SPARSE_SELECTION_FORMAT = 'worldrenew-sparse-selection';
export const SPARSE_SELECTION_LIMITS = Object.freeze({ maxBoxes: 100_000, maxOperations: 10_000_000, maxSerializedBytes: 64 * 1024 * 1024 });
const KEYS = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'];
const AXES = ['X', 'Y', 'Z'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Inclusive block bounds, deliberately independent of the small legacy preview limits. */
export function validateSelectionBounds(input) {
  requireThat(plain(input), 'SPARSE_BOUNDS', 'Enter inclusive block selection bounds.');
  const bounds = {};
  for (const key of KEYS) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    requireThat(field && 'value' in field && Number.isSafeInteger(field.value) && Math.abs(field.value) <= SELECTION_COORDINATE_LIMIT, 'SPARSE_BOUNDS', 'Selection coordinates must be whole numbers within ±30,000,000.');
    bounds[key] = field.value;
  }
  for (const axis of AXES) requireThat(bounds[`min${axis}`] <= bounds[`max${axis}`], 'SPARSE_BOUNDS', 'Each maximum coordinate must be at least its minimum.');
  return bounds;
}

function point(x, y, z) { return validateSelectionBounds({ minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z }); }
function optionsOf(options) {
  requireThat(plain(options), 'SPARSE_SCHEMA', 'Selection options must be an object.');
  const result = { ...SPARSE_SELECTION_LIMITS };
  for (const key of Object.keys(result)) {
    if (options[key] !== undefined) result[key] = options[key];
    requireThat(Number.isSafeInteger(result[key]) && result[key] > 0, 'SPARSE_SCHEMA', `${key} must be a positive safe integer.`);
  }
  return result;
}

// Clone only JSON data, including extension fields, without invoking toJSON or accepting
// cycles, accessors, exotic objects, non-finite numbers, or excessive nesting.
function cloneJson(value, budget, depth = 0) {
  requireThat(depth <= 64 && --budget.nodes >= 0, 'SPARSE_SCHEMA', 'Selection metadata is too complex.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { budget.bytes -= Buffer.byteLength(value); requireThat(budget.bytes >= 0, 'SPARSE_SCHEMA', 'Selection metadata is too large.'); return value; }
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'SPARSE_SCHEMA', 'Selection metadata must contain finite JSON numbers.'); return value; }
  requireThat(Array.isArray(value) || plain(value), 'SPARSE_SCHEMA', 'Selection metadata must contain JSON data.');
  requireThat(Object.getOwnPropertySymbols(value).length === 0, 'SPARSE_SCHEMA', 'Selection metadata must not contain symbol fields.');
  requireThat(!budget.parents.has(value), 'SPARSE_SCHEMA', 'Selection metadata must not contain cycles.');
  if (Array.isArray(value)) requireThat(value.length <= budget.nodes && Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index)), 'SPARSE_SCHEMA', 'Selection metadata arrays must be dense JSON arrays.');
  budget.parents.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(descriptor && 'value' in descriptor, 'SPARSE_SCHEMA', 'Selection metadata must not contain accessors.');
    budget.bytes -= Buffer.byteLength(key);
    requireThat(budget.bytes >= 0, 'SPARSE_SCHEMA', 'Selection metadata is too large.');
    Object.defineProperty(result, key, { value: cloneJson(descriptor.value, budget, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  budget.parents.delete(value);
  return result;
}
function jsonClone(value, limit) {
  const result = cloneJson(value, { bytes: limit, nodes: Math.min(1_000_000, Math.max(1024, limit)), parents: new Set() });
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= limit, 'SPARSE_SCHEMA', 'Serialized selection is too large.');
  return result;
}
const compareBoxes = (a, b) => a.minZ - b.minZ || a.minX - b.minX || a.minY - b.minY || a.maxZ - b.maxZ || a.maxX - b.maxX || a.maxY - b.maxY;
const intersects = (a, b) => AXES.every(axis => a[`min${axis}`] <= b[`max${axis}`] && a[`max${axis}`] >= b[`min${axis}`]);
const encloses = (a, b) => AXES.every(axis => a[`min${axis}`] <= b[`min${axis}`] && a[`max${axis}`] >= b[`max${axis}`]);
const countBox = b => AXES.reduce((n, axis) => n * BigInt(b[`max${axis}`] - b[`min${axis}`] + 1), 1n);
function operationBudget(limits) {
  let operations = 0;
  return () => requireThat(++operations <= limits.maxOperations, 'SPARSE_COMPLEXITY', 'Selection edit complexity exceeds the configured operation limit.');
}
function checkCount(boxes, limits) { requireThat(boxes.length <= limits.maxBoxes, 'SPARSE_COMPLEXITY', 'Selection edit complexity exceeds the configured box limit.'); }

/** Difference of inclusive cuboids: at most six disjoint pieces, never per-cell data. */
function subtract(a, b) {
  if (!intersects(a, b)) return [a];
  const middle = { ...a }, pieces = [];
  for (const axis of AXES) {
    const lo = `min${axis}`, hi = `max${axis}`;
    if (middle[lo] < b[lo]) { pieces.push({ ...middle, [hi]: b[lo] - 1 }); middle[lo] = b[lo]; }
    if (middle[hi] > b[hi]) { pieces.push({ ...middle, [lo]: b[hi] + 1 }); middle[hi] = b[hi]; }
  }
  return pieces;
}
function extensions(box) { return Object.fromEntries(Object.entries(box).filter(([key]) => !KEYS.includes(key))); }

// Adjacent cuboids with matching extensions can be rejoined after block refinement.
// Sorting and coalescing is deterministic; it does not allocate the bounding volume.
function coalesce(input, work) {
  let boxes = input, changed;
  do {
    changed = false;
    for (const axis of AXES) {
      const otherKeys = KEYS.filter(key => !key.endsWith(axis));
      const groups = new Map();
      for (const box of boxes) {
        work();
        const key = JSON.stringify([otherKeys.map(k => box[k]), extensions(box)]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(box);
      }
      const joined = [];
      for (const group of groups.values()) {
        group.sort((a, b) => a[`min${axis}`] - b[`min${axis}`]);
        let previous;
        for (const box of group) {
          if (previous && previous[`max${axis}`] + 1 === box[`min${axis}`]) {
            previous = { ...previous, [`max${axis}`]: box[`max${axis}`] }; joined[joined.length - 1] = previous; changed = true;
          } else { previous = box; joined.push(box); }
        }
      }
      boxes = joined;
    }
  } while (changed);
  return boxes.sort(compareBoxes);
}

function checkDisjoint(boxes, work) {
  // Sweep the axis with the greatest spread first; distant disconnected pieces
  // require no pair comparisons. The operation budget bounds adversarial overlap.
  let axis = 'X', bestSpan = -1;
  for (const candidate of AXES) {
    let lo = Infinity, hi = -Infinity;
    for (const box of boxes) { lo = Math.min(lo, box[`min${candidate}`]); hi = Math.max(hi, box[`max${candidate}`]); }
    if (hi - lo > bestSpan) { bestSpan = hi - lo; axis = candidate; }
  }
  const sorted = [...boxes].sort((a, b) => a[`min${axis}`] - b[`min${axis}`]);
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j][`min${axis}`] <= sorted[i][`max${axis}`]; j++) {
    work(); requireThat(!intersects(sorted[i], sorted[j]), 'SPARSE_SCHEMA', 'Serialized selection boxes must not overlap.');
  }
}
function abortIfNeeded(signal) {
  if (signal?.aborted) { const error = new Error('Selection iteration was cancelled.', { cause: signal.reason }); error.name = 'AbortError'; error.code = 'ABORT_ERR'; throw error; }
}
function mergeIntervals(intervals) {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + 1) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]);
  }
  return merged;
}
function fillBits(mask, first, last) {
  const firstByte = first >> 3, lastByte = last >> 3;
  if (firstByte === lastByte) { mask[firstByte] |= ((0xff >>> (7 - (last & 7))) & (0xff << (first & 7))); return; }
  mask[firstByte] |= 0xff << (first & 7);
  mask.fill(0xff, firstByte + 1, lastByte);
  mask[lastByte] |= 0xff >>> (7 - (last & 7));
}
function* sectionsForChunk(boxes, x, z, signal) {
  const baseX = x * 16, baseZ = z * 16;
  const ranges = mergeIntervals(boxes.map(b => [Math.floor(b.minY / 16), Math.floor(b.maxY / 16)]));
  for (const [lo, hi] of ranges) for (let y = lo; y <= hi; y++) {
    abortIfNeeded(signal);
    const baseY = y * 16, mask = Buffer.alloc(512);
    let selectedCount = 0;
    for (const b of boxes) {
      const minY = Math.max(b.minY, baseY), maxY = Math.min(b.maxY, baseY + 15);
      if (minY > maxY) continue;
      const minX = Math.max(b.minX, baseX), maxX = Math.min(b.maxX, baseX + 15), minZ = Math.max(b.minZ, baseZ), maxZ = Math.min(b.maxZ, baseZ + 15);
      selectedCount += (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      for (let by = minY; by <= maxY; by++) for (let bz = minZ; bz <= maxZ; bz++) {
        const row = (by - baseY) * 256 + (bz - baseZ) * 16;
        fillBits(mask, row + minX - baseX, row + maxX - baseX);
      }
    }
    yield { y, mask, selectedCount };
  }
}

/**
 * Mutable sparse membership only: selected air and unknown terrain are resolved by
 * capture, never inferred here. Memory scales with refinement complexity, not size.
 * Edits are atomic on validation/complexity failure. Iterators take a stable snapshot.
 */
export class SparseSelection {
  #boxes; #limits; #extensions = {};
  constructor(boxes = [], options = {}) {
    this.#limits = optionsOf(options);
    requireThat(Array.isArray(boxes), 'SPARSE_SCHEMA', 'Selection boxes must be an array.');
    checkCount(boxes, this.#limits);
    const copied = jsonClone(boxes, this.#limits.maxSerializedBytes).map(box => ({ ...box, ...validateSelectionBounds(box) }));
    const work = operationBudget(this.#limits);
    checkDisjoint(copied, work);
    this.#boxes = coalesce(copied, work);
  }
  static fromJSON(input, options = {}) {
    const limits = optionsOf(options);
    if (typeof input === 'string') {
      requireThat(Buffer.byteLength(input) <= limits.maxSerializedBytes, 'SPARSE_SCHEMA', 'Serialized selection is too large.');
      try { input = JSON.parse(input); } catch { requireThat(false, 'SPARSE_SCHEMA', 'Serialized selection is not valid JSON.'); }
    }
    requireThat(plain(input), 'SPARSE_SCHEMA', 'Invalid sparse selection format or version.');
    const copied = jsonClone(input, limits.maxSerializedBytes);
    requireThat(copied.format === SPARSE_SELECTION_FORMAT && copied.schemaVersion === 1 && Array.isArray(copied.boxes), 'SPARSE_SCHEMA', 'Invalid sparse selection format or version.');
    checkCount(copied.boxes, limits);
    const selection = new SparseSelection(copied.boxes, limits);
    selection.#extensions = Object.fromEntries(Object.entries(copied).filter(([key]) => !['format', 'schemaVersion', 'boxes'].includes(key)));
    return selection;
  }
  get boxCount() { return this.#boxes.length; }
  get blockCount() { return this.#boxes.reduce((n, box) => n + countBox(box), 0n); }
  get bounds() {
    if (!this.#boxes.length) return null;
    const bounds = validateSelectionBounds(this.#boxes[0]);
    for (const box of this.#boxes) for (const axis of AXES) { bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], box[`min${axis}`]); bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], box[`max${axis}`]); }
    return bounds;
  }
  contains(x, y, z) { const block = point(x, y, z); return this.#boxes.some(box => encloses(box, block)); }
  addBlock(x, y, z) { return this.addBox(point(x, y, z)); }
  removeBlock(x, y, z) { return this.removeBox(point(x, y, z)); }
  addBox(input) {
    const box = validateSelectionBounds(input), work = operationBudget(this.#limits);
    // Whole-box additions can replace ordinary contained pieces, but extension
    // records on retained selected cells survive refinements and serialization.
    const kept = this.#boxes.filter(existing => { work(); return !encloses(box, existing) || Object.keys(extensions(existing)).length > 0; });
    let pieces = [box];
    for (const existing of kept) {
      const next = [];
      for (const piece of pieces) { work(); next.push(...subtract(piece, existing)); checkCount(next, this.#limits); }
      pieces = next;
      if (!pieces.length) break;
    }
    const result = coalesce([...kept, ...pieces], work);
    checkCount(result, this.#limits); this.#boxes = result; return this;
  }
  removeBox(input) {
    const box = validateSelectionBounds(input), work = operationBudget(this.#limits), pieces = [];
    for (const existing of this.#boxes) { work(); pieces.push(...subtract(existing, box)); checkCount(pieces, this.#limits); }
    const result = coalesce(pieces, work);
    checkCount(result, this.#limits); this.#boxes = result; return this;
  }
  toJSON() { return jsonClone({ ...this.#extensions, format: SPARSE_SELECTION_FORMAT, schemaVersion: 1, boxes: this.#boxes }, this.#limits.maxSerializedBytes); }
  /** z then x chunk order; sections are a lazy, one-shot iterable in ascending y. */
  iterateChunks({ signal, onProgress = () => {} } = {}) {
    const boxes = this.#boxes;
    requireThat(typeof onProgress === 'function', 'SPARSE_SCHEMA', 'Selection progress callback must be a function.');
    return (function* () {
      abortIfNeeded(signal);
      const projected = boxes.map(box => ({ box, minX: Math.floor(box.minX / 16), maxX: Math.floor(box.maxX / 16), minZ: Math.floor(box.minZ / 16), maxZ: Math.floor(box.maxZ / 16) }));
      let z = Infinity, chunksVisited = 0;
      for (const b of projected) z = Math.min(z, b.minZ);
      while (z !== Infinity) {
        abortIfNeeded(signal);
        const active = projected.filter(b => b.minZ <= z && b.maxZ >= z);
        const intervals = mergeIntervals(active.map(b => [b.minX, b.maxX]));
        for (const [lo, hi] of intervals) for (let x = lo; x <= hi; x++) {
          abortIfNeeded(signal);
          const chunkBoxes = active.filter(b => b.minX <= x && b.maxX >= x).map(b => b.box);
          onProgress({ phase: 'selection', chunksVisited: ++chunksVisited, chunkX: x, chunkZ: z });
          abortIfNeeded(signal);
          yield { x, z, sections: sectionsForChunk(chunkBoxes, x, z, signal) };
        }
        let next = Infinity;
        for (const b of projected) if (b.maxZ > z) next = Math.min(next, Math.max(z + 1, b.minZ));
        z = next;
      }
    })();
  }
  iterateSections(options = {}) {
    const chunks = this.iterateChunks(options);
    return (function* () { for (const { x, z, sections } of chunks) for (const section of sections) yield { x, z, ...section }; })();
  }
}

export function createSparseSelection(a, b, options = {}) {
  requireThat(plain(a) && plain(b), 'SPARSE_BOUNDS', 'Choose two block corners.');
  point(a.x, a.y, a.z); point(b.x, b.y, b.z);
  return new SparseSelection([{ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) }], options);
}
export const deserializeSparseSelection = (input, options) => SparseSelection.fromJSON(input, options);
