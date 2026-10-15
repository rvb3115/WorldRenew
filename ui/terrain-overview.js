export const OVERVIEW_LIMIT=16384;
export function overviewSample(chunks,limit=OVERVIEW_LIMIT){
  if(!Number.isInteger(limit)||limit<1||limit>OVERVIEW_LIMIT)throw new Error('Invalid overview budget.');
  if(chunks.length<=limit)return chunks;
  if(limit===1)return [chunks[0]];
  return Array.from({length:limit},(_,i)=>chunks[Math.floor(i*(chunks.length-1)/(limit-1))]);
}
export function overviewColor(tile){
  if(tile.status!=='ready')return tile.status==='unsupported'?'#71617e':tile.status==='absent'?'#233b43':'#d98b9e';
  let count=0,r=0,g=0,b=0;
  for(let i=0;i<256;i++)if(tile.ids[i]){count++;r+=tile.rgba[i*4];g+=tile.rgba[i*4+1];b+=tile.rgba[i*4+2];}
  return count?`rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`:'#35515e';
}
