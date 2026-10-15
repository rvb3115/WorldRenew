import { summarizeTerrain, SUMMARY_STATES } from '../engine/terrain-summary.js';
export function overviewColor(tile) { return '#' + summarizeTerrain(tile).rgb.toString(16).padStart(6,'0'); }
/** Five bytes per indexed chunk; no full-resolution data or coverage sampling. */
export class CompactOverview {
  constructor(index) { this.index=index;this.states=new Uint8Array(index.size);this.colors=new Uint32Array(index.size);this.counts=new Uint32Array(6);this.counts[0]=index.size; }
  get bytes(){return this.states.byteLength+this.colors.byteLength;}
  get completed(){return this.states.length-this.counts[0];}
  has(id){const i=this.index.get(id);return i!==undefined&&this.states[i]!==0;}
  set(id,{state,rgb}){const i=this.index.get(id);if(i===undefined)return;this.counts[this.states[i]]--;this.states[i]=state;this.colors[i]=rgb;this.counts[state]++;}
  delete(id){this.set(id,{state:0,rgb:0});}
  get(id){
    const i=this.index.get(id),state=this.states[i];if(!state)return undefined;
    return {status:state===5?'unreadable':SUMMARY_STATES[state],code:state===5?'CHUNK_STATUS':undefined,
      message:state===5?'Generation incomplete. Missing terrain was not inferred.':state===3?'Unreadable saved chunk. Zoom in for its diagnostic.':state===4?'Unsupported saved chunk. Zoom in for its diagnostic.':undefined,
      color:'#'+this.colors[i].toString(16).padStart(6,'0')};
  }
}
/** Seed each region with actual samples, then finish regions in contiguous batches.
 * Keeping each request in one region avoids thrashing the bounded header/cache LRU.
 * Samples never paint neighboring uninspected chunks: those remain pending.
 */
export class OverviewQueue {
  constructor(coarse){this.coarse=coarse;this.queue=[];this.seedHead=0;this.head=0;}
  add(region){
    const cells=new Map();
    for(let i=0;i<region.chunks.length;i++){
      const c=region.chunks[i],x=(c.x%32+32)%32,z=(c.z%32+32)%32,id=Math.floor(z/8)*4+Math.floor(x/8);
      const distance=(x%8-4)**2+(z%8-4)**2;
      if(!cells.has(id)||distance<cells.get(id).distance)cells.set(id,{index:i,distance});
    }
    const sample=[...cells.values()].map(c=>c.index);
    this.queue.push({region,cursor:0,sample,sampleCursor:0});
  }
  take(limit){
    if(!Number.isInteger(limit)||limit<1)throw new Error('Use a positive bounded batch size.');
    const batch=[];
    // One region per request, including the first coverage pass.
    while(this.seedHead<this.queue.length){
      const item=this.queue[this.seedHead];
      while(item.sampleCursor<item.sample.length&&batch.length<limit){
        const c=item.region.chunks[item.sample[item.sampleCursor++]];
        if(!this.coarse.has(`${c.x},${c.z}`))batch.push(c);
      }
      if(item.sampleCursor===item.sample.length)this.seedHead++;
      if(batch.length)return batch;
    }
    while(this.head<this.queue.length){
      const item=this.queue[this.head],chunks=item.region.chunks;
      while(item.cursor<chunks.length&&batch.length<limit){
        const c=chunks[item.cursor++];if(!this.coarse.has(`${c.x},${c.z}`))batch.push(c);
      }
      if(item.cursor===chunks.length)this.head++;
      if(batch.length)return batch;
    }
    return batch;
  }
  get pending(){return this.seedHead<this.queue.length||this.head<this.queue.length;}
  get seeding(){return this.seedHead<this.queue.length;}
}
