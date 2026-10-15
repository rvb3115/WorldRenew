// Pure helpers: coordinates are absolute blocks, and bounds are inclusive.
const fields = ['minX','minY','minZ','maxX','maxY','maxZ'];
export function previewBounds(bounds) {
  if (!bounds || !fields.every(k => Number.isSafeInteger(bounds[k]) && Math.abs(bounds[k]) <= 30000000) ||
      ['X','Y','Z'].some(a => bounds[`min${a}`] > bounds[`max${a}`])) throw new Error('Choose valid whole block coordinates inside the world border.');
  return Object.fromEntries(fields.map(k => [k,bounds[k]]));
}
export function previewLimitMessage(bounds) {
  const b=previewBounds(bounds),x=b.maxX-b.minX+1,y=b.maxY-b.minY+1,z=b.maxZ-b.minZ+1;
  return x>128||y>384||z>128||x*y*z>1048576 ? 'This rectangular selection exceeds the block preview limit: 128 × 384 × 128 extent and 1,048,576 blocks. Reduce its bounds or use the 3D topographic view. No substitute area was loaded.' : null;
}
export function matchingPreview(volume,request) {
  return Boolean(volume&&volume.root===request.root&&volume.dimension===request.dimension&&fields.every(k=>volume.bounds?.[k]===request.bounds?.[k]));
}
export function matchingPreviewRequest(a,b) {
  return Boolean(a&&b&&a.root===b.root&&a.dimension===b.dimension&&fields.every(k=>a.bounds?.[k]===b.bounds?.[k]));
}
export function previewLocationText(dimension,bounds) {
  const b=previewBounds(bounds);
  return `${dimension} · X ${b.minX}…${b.maxX} · Y ${b.minY}…${b.maxY} · Z ${b.minZ}…${b.maxZ}. Rectangular bounds include any unselected gaps between chunks.`;
}
/** Frame requested bounds instead of the subset that happened to contain solids. */
export function blockPreviewFrame(bounds,{aspect=1,fov=65}={}) {
  const b=previewBounds(bounds);
  if(!Number.isFinite(aspect)||aspect<=0||!Number.isFinite(fov)||fov<=0||fov>=180)throw new Error('Invalid preview viewport.');
  const center={x:(b.minX+b.maxX+1)/2,y:(b.minY+b.maxY+1)/2,z:(b.minZ+b.maxZ+1)/2};
  const radius=Math.hypot(b.maxX-b.minX+1,b.maxY-b.minY+1,b.maxZ-b.minZ+1)/2;
  const halfAngle=Math.min(fov*Math.PI/360,Math.atan(Math.tan(fov*Math.PI/360)*aspect));
  const distance=Math.max(2,radius/Math.sin(halfAngle)*1.1),normal=Math.hypot(.8,.6,.95);
  return {center,position:{x:center.x+distance*.8/normal,y:center.y+distance*.6/normal,z:center.z+distance*.95/normal},distance};
}
