// Display-only geometry. Unknown columns never become a floor or a solid block.
export const TOPO_RADIUS = 5;
export const TOPO_CHUNK_LIMIT = (TOPO_RADIUS * 2 + 1) ** 2;
export const TOPO_TRIANGLE_LIMIT = TOPO_CHUNK_LIMIT * (256 * 10 + 2);
export function topographicWindow(blockX, blockZ) {
  if (![blockX, blockZ].every(Number.isFinite)) throw new Error('Invalid topographic center.');
  const cx = Math.floor(blockX / 16), cz = Math.floor(blockZ / 16), cells = [];
  for (let z = cz - TOPO_RADIUS; z <= cz + TOPO_RADIUS; z++) for (let x = cx - TOPO_RADIUS; x <= cx + TOPO_RADIUS; x++) {
    if (Math.abs(x) <= 1875000 && Math.abs(z) <= 1875000) cells.push({ x, z });
  }
  return cells.sort((a,b) => Math.hypot(a.x-cx,a.z-cz)-Math.hypot(b.x-cx,b.z-cz));
}
const linear = byte => { const c = byte / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
function validate(tile) {
  if (tile?.status !== 'ready' || tile.heights?.length !== 256 || tile.ids?.length !== 256 || tile.rgba?.length !== 1024 || !Array.isArray(tile.palette)) throw new Error('A complete decoded terrain tile is required.');
  for (let i=0;i<256;i++) if (!Number.isInteger(tile.ids[i]) || tile.ids[i]<0 || tile.ids[i]>=tile.palette.length || (tile.ids[i] && (!Number.isInteger(tile.heights[i]) || tile.heights[i]<-64 || tile.heights[i]>319))) throw new Error('Invalid terrain column.');
}
export function surfaceGeometry(tile, neighbors = {}) {
  validate(tile);
  const positions=[], colors=[], faceColumns=[], grid=[];
  function quad(points, color, column, shade=1) {
    for (const index of [0,1,2,0,2,3]) { positions.push(...points[index]); colors.push(...color.map(c=>c*shade)); }
    faceColumns.push(column,column);
  }
  function adjacent(x,z) {
    if(x>=0&&x<16&&z>=0&&z<16){const i=z*16+x;return tile.ids[i]?tile.heights[i]+1:null;}
    const next=x<0?neighbors.west:x>15?neighbors.east:z<0?neighbors.north:neighbors.south;
    if(next?.status!=='ready')return null;
    const i=((z+16)%16)*16+(x+16)%16;
    return next.ids[i]?next.heights[i]+1:null;
  }
  for(let z=0;z<16;z++)for(let x=0;x<16;x++){
    const i=z*16+x;if(!tile.ids[i])continue;
    const y=tile.heights[i]+1,color=[0,1,2].map(c=>linear(tile.rgba[i*4+c]));
    quad([[x,y,z],[x,y,z+1],[x+1,y,z+1],[x+1,y,z]],color,i);
    const edges=[{dx:-1,dz:0,a:[x,y,z+1],b:[x,y,z],edge:x===0},{dx:1,dz:0,a:[x+1,y,z],b:[x+1,y,z+1],edge:x===15},{dx:0,dz:-1,a:[x,y,z],b:[x+1,y,z],edge:z===0},{dx:0,dz:1,a:[x+1,y,z+1],b:[x,y,z+1],edge:z===15}];
    for(const {dx,dz,a,b,edge} of edges){
      const below=adjacent(x+dx,z+dz);
      if(below!==null&&below<y)quad([a,[a[0],below,a[2]],[b[0],below,b[2]],b],color,i,.68);
      if(edge)grid.push(a[0],a[1]+.08,a[2],b[0],b[1]+.08,b[2]);
    }
  }
  return { positions:new Float32Array(positions), colors:new Float32Array(colors), faceColumns:new Uint16Array(faceColumns), grid:new Float32Array(grid) };
}
export function pickedColumn(tile, faceColumns, faceIndex) {
  const i=faceColumns[faceIndex];
  if(!Number.isInteger(i)||i<0||i>=256)return null;
  return {x:tile.x,z:tile.z,blockX:tile.x*16+i%16,blockZ:tile.z*16+Math.floor(i/16)};
}
