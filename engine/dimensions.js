// Vanilla presets; custom dimension settings are deliberately not inferred.
export const DIMENSIONS = Object.freeze({
  'minecraft:overworld': { minY: -64, maxY: 319, scale: 1 },
  'minecraft:the_nether': { minY: 0, maxY: 255, scale: 8, roofY: 128 },
  'minecraft:the_end': { minY: 0, maxY: 255, scale: 1 }
});
/** Coordinate guidance only. Minecraft resolves portal destinations at travel time. */
export function portalReview(source, sourceId, destinationId, anchor) {
  const delta = { x: anchor.x - source.bounds.minX, y: anchor.y - source.bounds.minY, z: anchor.z - source.bounds.minZ };
  let portalBlocks = 0, endPortalBlocks = 0, bedrockBlocks = 0, aboveRoofBlocks = 0;
  const portals = [], warnings = [];
  for (let i = 0; i < source.voxels.length; i++) {
    const state = source.palette[source.voxels[i]], name = state?.Name;
    const y = Math.floor(i / (source.size.x * source.size.z)) + source.bounds.minY;
    if (name === 'minecraft:bedrock') bedrockBlocks++;
    if (sourceId === 'minecraft:the_nether' && y >= 128 && name && !['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(name)) aboveRoofBlocks++;
    if (name === 'minecraft:end_portal' || name === 'minecraft:end_gateway') endPortalBlocks++;
    if (name !== 'minecraft:nether_portal') continue;
    portalBlocks++;
    if (portals.length < 32) {
      const x = i % source.size.x + source.bounds.minX, z = Math.floor(i / source.size.x) % source.size.z + source.bounds.minZ;
      const placed = { x: x + delta.x, y: y + delta.y, z: z + delta.z };
      const scale = destinationId === 'minecraft:the_nether' ? 8 : destinationId === 'minecraft:overworld' ? 1/8 : null;
      portals.push({ source: {x,y,z}, placed, oppositeTarget: scale === null ? null : {x: placed.x * scale, z: placed.z * scale} });
    }
  }
  let counterpartTranslation = null;
  if (sourceId === destinationId && ['minecraft:overworld','minecraft:the_nether'].includes(sourceId)) {
    const factor = sourceId === 'minecraft:the_nether' ? 8 : 1/8;
    counterpartTranslation = { dimension: sourceId === 'minecraft:the_nether' ? 'minecraft:overworld' : 'minecraft:the_nether', x: delta.x * factor, z: delta.z * factor, wholeBlocks: Number.isInteger(delta.x * factor) && Number.isInteger(delta.z * factor) };
  }
  if (sourceId !== destinationId) warnings.push('Cross-dimension placement: terrain, portal behavior, build height and environment differ. Dimension coordinates are not automatically scaled.');
  if (sourceId === 'minecraft:the_nether' || destinationId === 'minecraft:the_nether') {
    warnings.push('Nether roof mode is a height selection in the Nether, not a separate dimension. Include roof access, tunnels and support blocks deliberately.');
    if (bedrockBlocks) warnings.push(`${bedrockBlocks} bedrock blocks are included. Roof/floor bedrock must not be blended away in a future transfer.`);
    if (aboveRoofBlocks && anchor.y < 128) warnings.push('This selection includes blocks above the Nether roof, but its destination corner is below Y=128. Check the full vertical placement.');
  }
  if (portalBlocks) {
    warnings.push(`${portalBlocks} active Nether portal blocks detected (not a count of portal structures). Links are not stored as fixed pairs; existing destination portals and heights can change the route. No links have been validated or repaired.`);
    if (counterpartTranslation) warnings.push(`To keep the same horizontal portal alignment, the matching ${counterpartTranslation.dimension.replace('minecraft:', '')} network would need an offset of X ${counterpartTranslation.x}, Z ${counterpartTranslation.z}. This does not guarantee linking; Y and competing portals still need review.`);
    if (counterpartTranslation && !counterpartTranslation.wholeBlocks) warnings.push('That counterpart offset contains fractional blocks. Choose an Overworld X/Z move divisible by 8 to keep whole-block Nether alignment.');
  }
  if (endPortalBlocks) warnings.push('End portal/gateway blocks detected. End exit behavior and gateway destinations are not relocated or validated.');
  if (!DIMENSIONS[sourceId] || !DIMENSIONS[destinationId]) warnings.push('Custom dimension heights and coordinate scales are not certified. No portal scaling is assumed.');
  return { sourceDimension: sourceId, destinationDimension: destinationId, delta, portalBlocks, endPortalBlocks, bedrockBlocks, aboveRoofBlocks, counterpartTranslation, samples: portals, linksValidated: false, warnings };
}
