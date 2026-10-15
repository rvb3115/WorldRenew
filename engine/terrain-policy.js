// Shared read-only preview policy. It must never authorize an export adapter.
export const TERRAIN_BATCH_LIMIT = 16;
export const TERRAIN_CACHE_LIMIT = 2048;
export const TERRAIN_VISIBLE_LIMIT = 1024;
export const terrainHeights = Object.freeze({
  'minecraft:overworld': { minY: -64, maxY: 319 },
  'minecraft:the_nether': { minY: 0, maxY: 255 },
  'minecraft:the_end': { minY: 0, maxY: 255 }
});
// Explicit read adapters, independent of every write/export version policy.
export const terrainVersions = Object.freeze({ '1.21.11': 4671, '26.2': 4903, '26.3': 5023 });
export function terrainSupport(metadata, dimension) {
  const expected = terrainVersions[metadata?.version];
  if (!expected || metadata.snapshot || metadata.dataVersion !== expected || metadata.versionId !== expected)
    return 'Terrain preview supports stable Java 1.21.11 / 4671, 26.2 / 4903 and 26.3 / 5023 only. This world remains a chunk index; its terrain is unsupported.';
  if (!terrainHeights[dimension?.id]) return 'Custom dimension heights are unsupported. This view is a chunk index; no terrain is inferred.';
  return null;
}
