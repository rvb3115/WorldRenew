// Version names establish a target, not evidence that a particular schema is certified.
export function regenerationExportPolicy(metadata, dimensions) {
  const blockers = [];
  // Envelope-only removal does not decode or upgrade NBT. Do not infer future compatibility.
  if (metadata.version !== '26.3' || metadata.snapshot) blockers.push('Experimental regeneration export currently accepts stable Java 26.3 only. Other versions need a separate adapter.');
  // Verified from Mojang's installed stable 26.3 client version.json on 2026-10-14.
  if (metadata.dataVersion !== 5023 || metadata.versionId !== 5023) blockers.push('Export requires Java 26.3 DataVersion 5023 and matching Version.Id. A version label alone is insufficient.');
  if (!dimensions.length || dimensions.some(d => d.id !== 'minecraft:overworld' || d.path !== 'dimensions/minecraft/overworld')) blockers.push('Regeneration export supports only the namespaced vanilla Overworld. Nether, End, custom and legacy layouts remain preview-only.');
  return { adapter: 'java-26.3-overworld-anvil-envelope-v1', experimental: true, gameLoadTested: false, blockers };
}
export function versionPolicy(name, snapshot) {
  const match = typeof name === 'string' && /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(name);
  if (snapshot || !match) return { status: 'unverified', label: 'Snapshot or unknown version · inspection only' };
  const [, major, minor] = match.map(Number);
  if (major > 26 || (major === 26 && minor > 3)) return { status: 'future', label: 'Newer than baseline · unverified inspection' };
  if (major === 26 && minor === 3) return { status: 'baseline', label: '26.3 baseline · read-only foundation' };
  return { status: 'legacy', label: 'Older Java world · best-effort inspection' };
}

export const capabilities = Object.freeze({ inspect: true, protectionPlans: true, verifiedCopy: true, buildVolumePreview: true, placementPreview: true, savedSelections: true, portableBuildFiles: true, experimentalCopyPlacement: true, experimentalRegenerationExport: true, deleteChunks: false, upgrade: false, importBuild: false, merge: false, blend: false });
