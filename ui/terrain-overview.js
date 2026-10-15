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
/** Round-robin regions give early coverage, then visit every saved chunk once. */
export class OverviewQueue {
  constructor(coarse){this.coarse=coarse;this.queue=[];this.head=0;}
  add(region){this.queue.push({region,cursor:0});}
  take(limit){
    const batch=[];
    while(batch.length<limit&&this.head<this.queue.length){
      const item=this.queue[this.head++],chunks=item.region.chunks;
      while(item.cursor<chunks.length&&this.coarse.has(`${chunks[item.cursor].x},${chunks[item.cursor].z}`))item.cursor++;
      if(item.cursor<chunks.length){batch.push(chunks[item.cursor++]);if(item.cursor<chunks.length)this.queue.push(item);}
    }
    if(this.head>1024){this.queue=this.queue.slice(this.head);this.head=0;}
    return batch;
  }
  get pending(){return this.head<this.queue.length;}
}
