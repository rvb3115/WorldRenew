import { createChunkReader } from './chunks.js';
import { requireThat } from './errors.js';
import { readTypedNBT, field } from './typed-nbt.js';

export const REMOVAL_CONTENT_BUDGET = 256 * 1024 * 1024;
function requireAttachmentList(raw, name) {
  const list = field(readTypedNBT(raw), name);
  requireThat(list?.type === 9 && (list.elementType === 10 || list.elementType === 0 && list.value.length === 0), 'REMOVAL_SCHEMA', `${name} must be a compound list; unknown types are not treated as empty.`);
}
/** A deletion gate, not a relocation adapter. Never interpret an unreadable list as empty. */
export function inspectRemovalSafety(world, candidates, progress = () => {}, { byteBudget = REMOVAL_CONTENT_BUDGET } = {}) {
  requireThat(Number.isInteger(byteBudget) && byteBudget >= 0 && byteBudget <= REMOVAL_CONTENT_BUDGET, 'REMOVAL_LIMIT', 'Invalid removal inspection budget.');
  const blockers = [], checked = [];
  let expandedBytes = 0, blockEntities = 0, entities = 0;
  const dimensions = new Map(world.dimensions.map(d => [d.key, d]));
  for (const [index, candidate] of candidates.entries()) {
    if (expandedBytes >= byteBudget) { blockers.push('Removal content inspection exceeded its bounded budget. Reduce the selection and preview again.'); break; }
    progress({ phase: 'Checking containers and entities before removal', completed: index, total: candidates.length });
    const dimension = dimensions.get(candidate.dimension), reader = createChunkReader(world.root, dimension);
    const record = { ...candidate, status: 'blocked', blockEntities: null, entities: null };
    try {
      const terrain = reader.read(candidate.x, candidate.z);
      requireThat(terrain, 'REMOVAL_CONTENT', 'Selected terrain is missing.');
      expandedBytes += terrain.raw.length;
      requireThat(expandedBytes <= byteBudget, 'REMOVAL_LIMIT', 'Removal content inspection exceeded its bounded budget. Reduce the selection.');
      const nbt = terrain.nbt;
      requireThat(nbt.DataVersion === world.metadata.dataVersion && nbt.Level === undefined && nbt.TileEntities === undefined && nbt.Entities === undefined, 'REMOVAL_SCHEMA', 'Unrecognized terrain version or legacy attachment schema.');
      requireThat(Array.isArray(nbt.block_entities), 'REMOVAL_SCHEMA', 'The block-entity list is missing or unreadable.');
      requireAttachmentList(terrain.raw, 'block_entities');
      record.blockEntities = nbt.block_entities.length; blockEntities += record.blockEntities;
      if (record.blockEntities) blockers.push(`Chunk ${candidate.x}, ${candidate.z} contains ${record.blockEntities} block entities, which may include container inventories. Protect the entire chunk; removal is blocked.`);
      const entityChunk = reader.read(candidate.x, candidate.z, 'entities');
      if (entityChunk) {
        expandedBytes += entityChunk.raw.length;
        requireThat(expandedBytes <= byteBudget, 'REMOVAL_LIMIT', 'Removal content inspection exceeded its bounded budget. Reduce the selection.');
        const data = entityChunk.nbt;
        requireThat(data.DataVersion === world.metadata.dataVersion && Array.isArray(data.Position) && data.Position.length === 2 && data.Position[0] === candidate.x && data.Position[1] === candidate.z && Array.isArray(data.Entities), 'REMOVAL_SCHEMA', 'Entity coordinates, version or entity list cannot be verified.');
        requireAttachmentList(entityChunk.raw, 'Entities');
        record.entities = data.Entities.length;
      } else record.entities = 0;
      entities += record.entities;
      if (record.entities) blockers.push(`Chunk ${candidate.x}, ${candidate.z} contains ${record.entities} entities, including potentially inventory-bearing entities. Protect the entire chunk; removal is blocked.`);
      for (const region of reader.regions.values()) requireThat(!region?.issues.length, 'REMOVAL_SCHEMA', 'Region errors prevent establishing safe absence.');
      reader.verifyStable();
      record.status = record.blockEntities || record.entities ? 'contains-protected-data' : 'verified-empty-attachments';
    } catch (error) {
      record.reason = error.message;
      blockers.push(`Chunk ${candidate.x}, ${candidate.z}: container/entity preservation could not be verified (${error.message}). Removal is blocked.`);
    }
    checked.push(record);
  }
  return { policy: 'preserve-all-block-entities-and-entities', checked, expandedBytes, blockEntities, entities, complete: checked.length === candidates.length && checked.every(c => c.status !== 'blocked'), blockers: [...new Set(blockers)] };
}
