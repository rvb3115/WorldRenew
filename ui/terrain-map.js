import { terrainSupport, TERRAIN_BATCH_LIMIT, TERRAIN_CACHE_LIMIT, TERRAIN_VISIBLE_LIMIT } from '../engine/terrain-policy.js';
import {CompactOverview,OverviewQueue} from './terrain-overview.js';
import {summarizeTerrain} from '../engine/terrain-summary.js';
const key = (x, z) => `${x},${z}`;
const intersects = (x, z, size, b) => x + size > b.minX && z + size > b.minZ && x < b.maxX && z < b.maxZ;
const put = (map, id, value, limit) => { map.delete(id); map.set(id, value); while (map.size > limit) map.delete(map.keys().next().value); };
export class TerrainMap {
  constructor(api, redraw) {
    this.api=api;this.redraw=redraw;this.states=new Map();this.dimensions=new Map();this.tileLru=new Map();
    this.tiles=new Map();this.overviews=new Map();this.generation=0;this.inflight=false;this.timer=null;this.visible=[];this.enabled=false;this.regions=[];this.failedRegions=[];this.chunkIndex=new Map();
    this.dirtyRegions=new Set();this.base=null;
  }
  reset(world,dimension,session,mode,y) {
    this.generation++;clearTimeout(this.timer);this.timer=null;
    if(this.session!==session){this.states.clear();this.dimensions.clear();this.tileLru.clear();}
    Object.assign(this,{world,dimension,session,mode,y});
    this.reason=terrainSupport(world?.metadata,dimension);this.enabled=Boolean(dimension)&&!this.reason;
    this.regions=dimension?.regions??[];this.failedRegions=dimension?.unreadableRegions??[];
    let indexed=this.dimensions.get(dimension?.key);
    if(!indexed){
      const chunks=this.regions.flatMap(r=>r.chunks),index=new Map(chunks.map((c,i)=>[key(c.x,c.z),i]));
      indexed={chunks,index,regions:new Map(this.regions.map(r=>[key(r.rx,r.rz),r]))};
      if(dimension)this.dimensions.set(dimension.key,indexed);
    }
    this.chunkIndex=indexed.index;this.allChunks=indexed.chunks;this.regionIndex=indexed.regions;
    const id=JSON.stringify([dimension?.key,mode,mode==='cutaway'?y:null]);
    let state=this.states.get(id);
    if(!state)state={id,session,coarse:new CompactOverview(indexed.index),tiles:new Map(),stamps:new Map(),regions:this.regions,regionIndex:indexed.regions,dimension:dimension?.key,mode,y};
    this.states.delete(id);this.states.set(id,state);this.state=state;
    let bytes=[...this.states.values()].reduce((n,s)=>n+s.coarse.bytes,0);
    for(const [oldId,old] of this.states){
      if((bytes<=16*1024*1024&&this.states.size<=8)||old===state)break;
      bytes-=old.coarse.bytes;this.states.delete(oldId);for(const k of old.tiles.keys())this.tileLru.delete(oldId+':'+k);
    }
    this.coarse=state.coarse;this.tiles=state.tiles;state.epoch=(state.epoch??0)+1;state.validated=new Set();state.validateCursor=0;state.queue=new OverviewQueue(state.coarse);state.retry=[];state.turn=0;
    this.overviews.clear();this.dirtyRegions.clear();this.viewKey=null;this.base=null;this.visible=[];this.overLimit=false;this.lastError='';
  }
  rememberTile(state,tile) {
    const id=key(tile.x,tile.z),lruKey=state.id+':'+id;
    if(tile.status==='ready'){
      tile.image=document.createElement('canvas');tile.image.width=tile.image.height=16;
      tile.image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.rgba),16,16),0,0);
    }
    state.tiles.set(id,tile);this.tileLru.delete(lruKey);this.tileLru.set(lruKey,{state,id});
    while(this.tileLru.size>TERRAIN_CACHE_LIMIT){const k=this.tileLru.keys().next().value,v=this.tileLru.get(k);v.state.tiles.delete(v.id);this.tileLru.delete(k);}
  }
  regionReady(state,x,z){return state?.validated.has(key(Math.floor(x/32),Math.floor(z/32)));}
  overview(region) {
    let image = this.overviews.get(region.path);
    if (!image) {
      image = document.createElement('canvas'); image.width = image.height = 32;
      const c = image.getContext('2d');
      for (const chunk of region.chunks) {
        c.fillStyle = region.issues.length || !chunk.valid ? '#a84c65' : this.reason ? '#71617e' : (this.regionReady(this.state,chunk.x,chunk.z)?this.coarse.get(key(chunk.x,chunk.z))?.color:null)??'#4c5d69';
        c.fillRect((chunk.x % 32 + 32) % 32, (chunk.z % 32 + 32) % 32, 1, 1);
      }
      put(this.overviews, region.path, image, 128);
    }
    return image;
  }
  paint(ctx, view, width, height) {
    const bounds = { minX: view.x, minZ: view.z, maxX: view.x + width / view.scale, maxZ: view.z + height / view.scale };
    const viewKey=[view.x,view.z,view.scale,width,height].join(':');
    const collect=viewKey!==this.viewKey;ctx.imageSmoothingEnabled=false;
    if(collect){
      this.base=document.createElement('canvas');this.base.width=width;this.base.height=height;
      let total=0;const found=[];
      for(const r of this.regions)if(intersects(r.rx*32,r.rz*32,32,bounds)){
        this.dirtyRegions.add(key(r.rx,r.rz));
        for(const c of r.chunks)if(intersects(c.x,c.z,1,bounds)){total++;if(found.length<=TERRAIN_VISIBLE_LIMIT)found.push(c);}
      }
      this.viewKey=viewKey;this.overviewTotal=total;this.overLimit=total>TERRAIN_VISIBLE_LIMIT;this.visible=this.overLimit?[]:found;
    }
    const base=this.base.getContext('2d');base.imageSmoothingEnabled=false;
    for(const id of this.dirtyRegions){
      const r=this.regionIndex.get(id);if(!r||!intersects(r.rx*32,r.rz*32,32,bounds))continue;
      const sx=(r.rx*32-view.x)*view.scale,sz=(r.rz*32-view.z)*view.scale;
      base.clearRect(sx,sz,32*view.scale,32*view.scale);base.drawImage(this.overview(r),sx,sz,32*view.scale,32*view.scale);
      if(r.issues.length)this.pattern(base,sx,sz,32*view.scale,'#b86677','Region error',width,height);
    }
    this.dirtyRegions.clear();ctx.drawImage(this.base,0,0);
    for (const r of this.failedRegions) if (intersects(r.rx * 32, r.rz * 32, 32, bounds))
      this.pattern(ctx, (r.rx * 32 - view.x) * view.scale, (r.rz * 32 - view.z) * view.scale, 32 * view.scale, '#b86677', 'Unreadable region', width, height);
    for (const tile of this.overLimit?[]:this.tiles.values()) {
      if (!this.regionReady(this.state,tile.x,tile.z)||!intersects(tile.x, tile.z, 1, bounds)) continue;
      const x = (tile.x - view.x) * view.scale, z = (tile.z - view.z) * view.scale;
      if (tile.image) ctx.drawImage(tile.image, x, z, view.scale, view.scale);
      else this.pattern(ctx, x, z, view.scale, tile.status === 'unsupported' ? '#b58bc6' : tile.status === 'absent' ? '#56716e' : '#e18e9e', tile.status === 'absent' ? 'Absent' : tile.status === 'unsupported' ? '?' : '!', width, height);
    }
    if (!this.overLimit) for (const c of this.visible) {
      const x = (c.x - view.x) * view.scale, z = (c.z - view.z) * view.scale;
      if (!this.tiles.has(key(c.x, c.z)) && view.scale >= 12) {
        ctx.fillStyle = '#c1c8cd'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(!c.valid ? '!' : this.reason ? '?' : '·', x + view.scale / 2, z + view.scale / 2 + 4);
      }
    }
    this.schedule(); this.describe();
  }
  pattern(ctx, x, z, size, color, label, width, height) {
    // Clip before drawing stripes so distant/huge regions never create huge loops.
    const left = Math.max(0, x), top = Math.max(0, z), right = Math.min(width, x + size), bottom = Math.min(height, z + size);
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    ctx.fillStyle = '#352b3a'; ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = color; ctx.globalAlpha = .6; ctx.lineWidth = 1;
    for (let i = left - (bottom - top); i < right; i += 10) { ctx.beginPath(); ctx.moveTo(i, bottom); ctx.lineTo(i + bottom - top, top); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff0f0'; ctx.textAlign = 'center'; ctx.font = '12px sans-serif';
    if (size >= 25) ctx.fillText(label, (left + right) / 2, (top + bottom) / 2 + 4);
    ctx.restore();
  }
  schedule() {
    if(this.timer||!this.enabled||this.inflight||document.body.classList.contains('busy'))return;
    const s=this.state;
    const detail=!this.overLimit&&this.visible.some(c=>this.regionReady(s,c.x,c.z)&&!s.tiles.has(key(c.x,c.z)));
    if(s.validateCursor>=s.regions.length&&!s.queue.pending&&!s.retry.length&&!detail)return;
    this.timer=setTimeout(()=>{this.timer=null;this.load();},this.retryDelay===400?400:0);
  }
  async load() {
    if(this.inflight||!this.enabled||document.body.classList.contains('busy'))return;
    const s=this.state,epoch=s.epoch,request={session:s.session,dimension:s.dimension,mode:s.mode,y:s.y};
    let chunks=[],validating=false;
    const detail=!this.overLimit?this.visible.filter(c=>this.regionReady(s,c.x,c.z)&&!s.tiles.has(key(c.x,c.z))).slice(0,TERRAIN_BATCH_LIMIT):[];
    if(s.validateCursor<s.regions.length&&(s.turn++%2===0||!s.queue.pending&&!detail.length)){
      validating=true;request.kind='overview';request.regions=s.regions.slice(s.validateCursor,s.validateCursor+32).map(({rx,rz})=>({rx,rz}));
    }else{
      chunks=s.retry.length?s.retry.splice(0,TERRAIN_BATCH_LIMIT):detail.length?detail:s.queue.take(TERRAIN_BATCH_LIMIT);
      if(!chunks.length){this.schedule();return;}
      request.chunks=chunks.map(({x,z})=>({x,z}));request.summaryOnly=!detail.length;
    }
    this.inflight=true;
    try{
      const response=await this.api.terrainTiles(request);
      if(s.session!==this.session||s.epoch!==epoch)return;
      if(response.error?.code==='TERRAIN_BUSY'){this.retryDelay=400;if(!validating)s.retry.unshift(...chunks);return;}
      this.retryDelay=0;
      if(response.error)throw Object.assign(new Error(response.error.message),{code:response.error.code});
      this.metrics=response.result;
      if(validating){
        for(const result of response.result.regions){
          const id=key(result.rx,result.rz),r=s.regionIndex.get(id);
          if(s.stamps.get(id)!==result.sourceStamp){
            for(const c of r.chunks){const k=key(c.x,c.z);s.coarse.delete(k);s.tiles.delete(k);this.tileLru.delete(s.id+':'+k);}
          }
          s.stamps.set(id,result.sourceStamp);s.validated.add(id);
          for(const [slot,state,rgb] of result.entries)s.coarse.set(key(result.rx*32+slot%32,result.rz*32+Math.floor(slot/32)),{state,rgb});
          s.queue.add(r);if(this.state===s){this.overviews.delete(r.path);this.dirtyRegions.add(id);}
        }
        s.validateCursor+=request.regions.length;
      }else{
        for(const summary of response.result.summaries??[])this.rememberOverview(s,summary);
        for(const tile of response.result.tiles)this.rememberTile(s,tile);
      }
    }catch(error){
      if(s.session!==this.session||s.epoch!==epoch)return;
      if(this.state===s){this.lastError=error.message;this.reason=error.message;this.enabled=false;s.validated.clear();this.overviews.clear();this.viewKey=null;}
      if(!validating)s.retry.unshift(...chunks);
    }finally{this.inflight=false;this.redraw();this.schedule();}
  }
  rememberOverview(state,tile){
    const id=key(tile.x,tile.z);state.coarse.set(id,tile.state?tile:summarizeTerrain(tile));
    if(this.state===state){const rid=key(Math.floor(tile.x/32),Math.floor(tile.z/32)),region=this.regionIndex.get(rid);if(region){this.overviews.delete(region.path);this.dirtyRegions.add(rid);}}
  }
  describe() {
    const el = document.getElementById('terrain-status');
    if (!this.dimension) { el.textContent = 'Surface colors load from your world. No uploads.'; return; }
    if (this.reason) { el.textContent = this.reason;Object.assign(el.dataset,{error:this.reason,mode:'unavailable',ready:0,pending:this.allChunks.length,overviewReady:0,overviewPending:this.allChunks.length});return; }
    delete el.dataset.error;
    const counts=this.coarse.counts,overviewPending=counts[0],overviewReady=counts[1],incomplete=counts[5],overviewFailed=counts[3]+counts[4]+incomplete;
    const validating=this.state.regions.length-this.state.validateCursor;
    Object.assign(el.dataset,{overviewReady,overviewPending,overviewFailed,overviewIncomplete:incomplete,validating,total:this.allChunks.length,decoded:this.metrics?.decoded??0,diskHits:this.metrics?.diskHits??0,cacheBytes:this.metrics?.disk?.bytes??0,summaryBytes:[...this.states.values()].reduce((n,s)=>n+s.coarse.bytes,0)});
    const progress=`Whole dimension: ${this.coarse.completed.toLocaleString()} / ${this.allChunks.length.toLocaleString()} checked · ${overviewPending.toLocaleString()} pending · ${incomplete.toLocaleString()} generation incomplete · ${(counts[3]+counts[4]).toLocaleString()} unreadable/unsupported${validating?` · validating ${validating} cached regions`:''}.`;
    if(this.overLimit){
      Object.assign(el.dataset,{mode:'overview',ready:overviewReady,pending:overviewPending,failed:overviewFailed,incomplete,sampled:this.allChunks.length});
      el.textContent=`${progress} Per-chunk terrain colors; zoom adds block detail. Gray is pending. ${this.metrics?.disk?.warning??''}`;return;
    }
    const tiles = this.visible.map(c => this.regionReady(this.state,c.x,c.z)?this.tiles.get(key(c.x,c.z)):null);
    const ready = tiles.filter(t => t?.status === 'ready').length, failed = tiles.filter(t => t && ['unreadable', 'unsupported'].includes(t.status)).length;
    const pending = tiles.filter(t => !t).length, fallback = tiles.filter(t => t?.fallbackColumns).length;
    el.textContent = `${this.dimension.issues.length ? 'Inspection errors: unindexed areas are unverified. ' : ''}${ready} terrain · ${pending} pending · ${failed} unreadable/unsupported${fallback ? ` · ${fallback} tiles use purple unknown-material colors` : ''}${this.lastError ? ` · ${this.lastError}` : ''}. ${progress} ${this.metrics?.disk?.warning??''} Refresh rereads the world.`;
    el.dataset.mode='detail';el.dataset.ready = ready; el.dataset.pending = pending; el.dataset.failed = failed;delete el.dataset.incomplete;delete el.dataset.sampled;
  }
  describePoint(blockX, blockZ) {
    const x = Math.floor(blockX / 16), z = Math.floor(blockZ / 16), tile = this.tiles.get(key(x, z));
    const failed = this.failedRegions.find(r => r.rx === Math.floor(x / 32) && r.rz === Math.floor(z / 32));
    const region = this.regions.find(r => r.rx === Math.floor(x / 32) && r.rz === Math.floor(z / 32));
    if (failed || region?.issues.length) return 'Unreadable region · ' + (failed?.message ?? region.issues[0]);
    if (!tile||!this.regionReady(this.state,x,z)){const coarse=this.regionReady(this.state,x,z)?this.coarse.get(key(x,z)):null;if(coarse)return coarse.status==='ready'?'Coarse terrain color loaded · zoom in for individual block details':`${coarse.status} · ${coarse.message??coarse.code}`;return this.chunkIndex.has(key(x, z)) ? this.reason ?? 'Pending · terrain not loaded' : this.dimension?.issues.length ? 'Not indexed · inspection has errors; absence is unverified' : 'Absent · no saved chunk in the inspected index';}
    if (tile.status !== 'ready') return `${tile.status} · ${tile.message ?? tile.code}`;
    const i = ((blockZ % 16 + 16) % 16) * 16 + ((blockX % 16 + 16) % 16);
    return tile.ids[i] ? `Y ${tile.heights[i]} · ${tile.palette[tile.ids[i]]}` : tile.emptyLabel;
  }
  requestWindow(cells) {
    this.viewKey=null;
    this.visible = cells.filter(c => this.chunkIndex.has(key(c.x,c.z)));
    this.overLimit = this.visible.length > TERRAIN_VISIBLE_LIMIT;
    this.schedule(); this.describe();
  }
  tileAt(x,z) {
    const cached=this.tiles.get(key(x,z));if(cached&&this.regionReady(this.state,x,z))return cached;
    const failed=this.failedRegions.find(r=>r.rx===Math.floor(x/32)&&r.rz===Math.floor(z/32));
    const region=this.regions.find(r=>r.rx===Math.floor(x/32)&&r.rz===Math.floor(z/32));
    if(failed||region?.issues.length)return {x,z,status:'unreadable'};
    if(this.chunkIndex.has(key(x,z)))return {x,z,status:this.reason?'unsupported':'pending'};
    return {x,z,status:this.dimension?.issues.length?'unreadable':'absent'};
  }
}
