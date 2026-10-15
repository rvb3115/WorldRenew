import { validateProtection } from './projects.js';

/** Future operation contracts stay independent from storage, version adapters and UI. */
export const operationTypes = Object.freeze(['regenerate-chunks', 'import-area', 'transform-area', 'merge-worlds', 'blend-boundary']);

export function previewRegeneration(world, selected, protection) {
  const candidates = validateProtection(world, selected), protectedChunks = validateProtection(world, protection);
  const key = c => `${c.dimension}:${c.x},${c.z}`, protectedKeys = new Set(protectedChunks.map(key));
  return {
    type: 'regenerate-chunks', executable: false,
    candidates: candidates.filter(c => !protectedKeys.has(key(c))),
    excludedProtected: candidates.filter(c => protectedKeys.has(key(c))),
    requiredGates: ['closed-world', 'certified-version-adapter', 'verified-backup', 'isolated-working-copy', 'terrain-entities-poi-consistency', 'post-write-validation', 'user-review'],
    explanation: 'Preview only. Regeneration requires deleting coordinated chunk records in a working copy, then opening that copy in the intended Minecraft version. No chunks are changed here.'
  };
}
