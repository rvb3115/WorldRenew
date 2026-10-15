import { terrainSupport, TERRAIN_BATCH_LIMIT, TERRAIN_CACHE_LIMIT, TERRAIN_VISIBLE_LIMIT } from '../engine/terrain-policy.js';
const key = (x, z) => `${x},${z}`;
const intersects = (x, z, size, b) => x + size > b.minX && z + size > b.minZ && x < b.maxX && z < b.maxZ;
const put = (map, id, value, limit) => { map.delete(id); map.set(id, value); while (map.size > limit) map.delete(map.keys().next().value); };
export class TerrainMap {
  constructor(api, redraw) {
    this.api = api; this.redraw = redraw; this.tiles = new Map(); this.overviews = new Map();
    this.generation = 0; this.inflight = false; this.timer = null; this.visible = []; this.enabled = false; this.regions = []; this.failedRegions = []; this.chunkIndex = new Map();
  }
  reset(world, dimension, session, mode, y) {
    this.generation++; clearTimeout(this.timer); this.tiles.clear(); this.overviews.clear();
    this.world = world; this.dimension = dimension; this.session = session; this.mode = mode; this.y = y;
    this.reason = terrainSupport(world?.metadata, dimension); this.enabled = Boolean(dimension) && !this.reason;
    this.regions = dimension?.regions ?? []; this.failedRegions = dimension?.unreadableRegions ?? [];
    this.chunkIndex = new Map();
    for (const r of this.regions) for (const c of r.chunks) this.chunkIndex.set(key(c.x, c.z), c);
    this.visible = []; this.overLimit = false; this.lastError = '';
  }
  overview(region) {
    let image = this.overviews.get(region.path);
    if (!image) {
      image = document.createElement('canvas'); image.width = image.height = 32;
      const c = image.getContext('2d');
      for (const chunk of region.chunks) {
        c.fillStyle = region.issues.length || !chunk.valid ? '#a84c65' : this.reason ? '#71617e' : '#4c5d69';
        c.fillRect((chunk.x % 32 + 32) % 32, (chunk.z % 32 + 32) % 32, 1, 1);
      }
      put(this.overviews, region.path, image, 128);
    }
    return image;
  }
  paint(ctx, view, width, height) {
    const bounds = { minX: view.x, minZ: view.z, maxX: view.x + width / view.scale, maxZ: view.z + height / view.scale };
    this.visible = []; this.overLimit = false; ctx.imageSmoothingEnabled = false;
    for (const r of this.regions) {
      if (!intersects(r.rx * 32, r.rz * 32, 32, bounds)) continue;
      const sx = (r.rx * 32 - view.x) * view.scale, sz = (r.rz * 32 - view.z) * view.scale;
      ctx.drawImage(this.overview(r), sx, sz, 32 * view.scale, 32 * view.scale);
      if (r.issues.length) this.pattern(ctx, sx, sz, 32 * view.scale, '#b86677', 'Region error', width, height);
      if (!this.overLimit) for (const c of r.chunks) if (intersects(c.x, c.z, 1, bounds)) {
        this.visible.push(c);
        if (this.visible.length > TERRAIN_VISIBLE_LIMIT) { this.overLimit = true; this.visible = []; break; }
      }
    }
    for (const r of this.failedRegions) if (intersects(r.rx * 32, r.rz * 32, 32, bounds))
      this.pattern(ctx, (r.rx * 32 - view.x) * view.scale, (r.rz * 32 - view.z) * view.scale, 32 * view.scale, '#b86677', 'Unreadable region', width, height);
    for (const tile of this.tiles.values()) {
      if (!intersects(tile.x, tile.z, 1, bounds)) continue;
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
    clearTimeout(this.timer);
    if (!this.enabled || this.overLimit || this.inflight || document.body.classList.contains('busy')) return;
    const pending = this.visible.filter(c => !this.tiles.has(key(c.x, c.z)));
    if (!pending.length) return;
    this.timer = setTimeout(() => this.load(), this.retryDelay ?? 90);
  }
  async load() {
    if (this.inflight || !this.enabled || this.overLimit || document.body.classList.contains('busy')) return;
    const pending = this.visible.filter(c => !this.tiles.has(key(c.x, c.z)));
    if (!pending.length) return;
    const cx = pending.reduce((s, c) => s + c.x, 0) / pending.length, cz = pending.reduce((s, c) => s + c.z, 0) / pending.length;
    pending.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    const chunks = pending.slice(0, TERRAIN_BATCH_LIMIT).map(({ x, z }) => ({ x, z })), generation = this.generation;
    this.inflight = true; this.describe();
    try {
      const response = await this.api.terrainTiles({ session: this.session, dimension: this.dimension.key, mode: this.mode, y: this.y, chunks });
      if (generation !== this.generation) return;
      if (response.error?.code === 'TERRAIN_BUSY') { this.retryDelay = 400; return; }
      this.retryDelay = 90;
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      for (const tile of response.result.tiles) {
        if (tile.status === 'ready') {
          tile.image = document.createElement('canvas'); tile.image.width = tile.image.height = 16;
          tile.image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.rgba), 16, 16), 0, 0);
          // Keep the 1 KiB projected color tile for the optional surface mesh.
        }
        put(this.tiles, key(tile.x, tile.z), tile, TERRAIN_CACHE_LIMIT);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.lastError = error.message;
      for (const c of chunks) put(this.tiles, key(c.x, c.z), { ...c, status: 'unreadable', message: error.message }, TERRAIN_CACHE_LIMIT);
      if (error.code === 'WORLD_CHANGED' || error.code === 'TERRAIN_SESSION') { this.enabled = false; this.tiles.clear(); this.reason = error.message; }
    } finally { this.inflight = false; this.redraw(); }
  }
  describe() {
    const el = document.getElementById('terrain-status');
    if (!this.dimension) { el.textContent = 'Surface colors load from your world. No uploads.'; return; }
    if (this.reason) { el.textContent = this.reason; return; }
    if (this.overLimit) { el.textContent = `Chunk index overview · Zoom in to load terrain (up to ${TERRAIN_VISIBLE_LIMIT.toLocaleString()} visible chunks at once). Hatched regions are unreadable.`; return; }
    const tiles = this.visible.map(c => this.tiles.get(key(c.x, c.z)));
    const ready = tiles.filter(t => t?.status === 'ready').length, failed = tiles.filter(t => t && ['unreadable', 'unsupported'].includes(t.status)).length;
    const pending = tiles.filter(t => !t).length, fallback = tiles.filter(t => t?.fallbackColumns).length;
    el.textContent = `${this.dimension.issues.length ? 'Inspection errors: unindexed areas are unverified. ' : ''}${ready} terrain · ${pending} pending · ${failed} unreadable/unsupported${fallback ? ` · ${fallback} tiles use purple unknown-material colors` : ''}${this.lastError ? ` · ${this.lastError}` : ''}. Refresh rereads the world.`;
    el.dataset.ready = ready; el.dataset.pending = pending; el.dataset.failed = failed;
  }
  describePoint(blockX, blockZ) {
    const x = Math.floor(blockX / 16), z = Math.floor(blockZ / 16), tile = this.tiles.get(key(x, z));
    const failed = this.failedRegions.find(r => r.rx === Math.floor(x / 32) && r.rz === Math.floor(z / 32));
    const region = this.regions.find(r => r.rx === Math.floor(x / 32) && r.rz === Math.floor(z / 32));
    if (failed || region?.issues.length) return 'Unreadable region · ' + (failed?.message ?? region.issues[0]);
    if (!tile) return this.chunkIndex.has(key(x, z)) ? this.reason ?? 'Pending · terrain not loaded' : this.dimension?.issues.length ? 'Not indexed · inspection has errors; absence is unverified' : 'Absent · no saved chunk in the inspected index';
    if (tile.status !== 'ready') return `${tile.status} · ${tile.message ?? tile.code}`;
    const i = ((blockZ % 16 + 16) % 16) * 16 + ((blockX % 16 + 16) % 16);
    return tile.ids[i] ? `Y ${tile.heights[i]} · ${tile.palette[tile.ids[i]]}` : tile.emptyLabel;
  }
  requestWindow(cells) {
    this.visible = cells.map(c => this.chunkIndex.get(key(c.x,c.z))).filter(Boolean);
    this.overLimit = this.visible.length > TERRAIN_VISIBLE_LIMIT;
    this.schedule(); this.describe();
  }
  tileAt(x,z) {
    const cached=this.tiles.get(key(x,z));if(cached)return cached;
    const failed=this.failedRegions.find(r=>r.rx===Math.floor(x/32)&&r.rz===Math.floor(z/32));
    const region=this.regions.find(r=>r.rx===Math.floor(x/32)&&r.rz===Math.floor(z/32));
    if(failed||region?.issues.length)return {x,z,status:'unreadable'};
    if(this.chunkIndex.has(key(x,z)))return {x,z,status:this.reason?'unsupported':'pending'};
    return {x,z,status:this.dimension?.issues.length?'unreadable':'absent'};
  }
}
