import { TerrainMap } from './terrain-map.js';
import { terrainHeights } from '../engine/terrain-policy.js';
import { TopographicMap } from './topographic-map.js';
import {applyChunkRange,selectionExtent} from './map-selection.js';
/* Renderer has no filesystem access. The narrow preload bridge owns all requests. */
const $ = id => document.getElementById(id), api = window.worldrenew;
let world = null, dimension = null, chunks = [], protectedChunks = new Map(), selection = new Set(), dirty = false, busy = false;
let regenerationReview = null, regenerationMarks = new Map();
let terrainSession = null;
let view = { x: 0, z: 0, scale: 8 }, gesture = null;
const canvas = $('map'), ctx = canvas.getContext('2d');
const terrain = new TerrainMap(api, () => draw());
let topographic = null, topographicActive = false;
let selectionBounds=null, dimensionSelections=new Map();
const key = (x, z) => `${x},${z}`;
const protectionKey = (dimension, x, z) => `${dimension}:${x},${z}`;
const fmt = value => value.toLocaleString();
function status(message, error = false) { $('status').textContent = message; $('status').title = message; document.querySelector('.statusbar').classList.toggle('error', error); }
function setBusy(value) {
  busy = value; document.body.classList.toggle('busy', value);
  $('open-build-file').disabled=$('templates-open').disabled=value;
  $('open').disabled = $('open-empty').disabled = value;
  $('open-transfer').disabled = value || !world;
  for (const id of ['rescan', 'dimension', 'fit', 'zoom-in', 'zoom-out', 'selection-fields', 'save', 'terrain-mode', 'map-view', 'topographic-north', 'map-jump', 'fit-selection', 'selection-mode', 'select-all', 'select-range', 'view-scale', 'view-scale-reset']) $(id).disabled = value || !world;
  updateSelection();
  if (!value) draw();
}
async function call(action, loading) {
  setBusy(true); status(loading);
  try { const response = await action(); if (response.error) throw new Error(response.error.message); return response.result; }
  catch (error) { status(error.message, true); return undefined; }
  finally { setBusy(false); }
}
function addDetail(name, value) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value ?? 'Unavailable'; $('metadata').append(dt, dd); }
function load(value) {
  dimensionSelections.clear();selection=new Set();dimension=null;
  terrainSession = value.terrainSession;
  world = value.report; protectedChunks = new Map(value.project.protection.map(c => [protectionKey(c.dimension, c.x, c.z), c])); dirty = false;
  $('world-name').textContent = world.metadata.name; $('world-path').textContent = world.root; $('world-path').title = world.root;
  $('metadata').replaceChildren();
  addDetail('Minecraft Java', world.metadata.version); addDetail('DataVersion', world.metadata.dataVersion); addDetail('Seed', world.metadata.seed);
  const configuration = world.metadata.configuration;
  if (configuration) {
    addDetail('Enabled features', configuration.enabledFeatures === null ? 'Unrecorded / unrecognized' : configuration.enabledFeatures.join(', ') || 'Recorded empty list');
    addDetail('Enabled datapacks', configuration.enabledPacks === null ? 'Unrecorded / unrecognized' : configuration.enabledPacks.join(', ') || 'Recorded empty list');
    addDetail('Generation settings', configuration.generationSource ?? 'Unknown · no recognized settings found');
    for (const setting of configuration.generatorSettings) addDetail(setting.dimension, setting.settings ?? 'Unknown generator settings');
    addDetail('Experiment history', configuration.featureHistory);
  }
  addDetail('Game mode', ['Survival', 'Creative', 'Adventure', 'Spectator'][world.metadata.gameMode] ?? 'Unknown');
  const time = Number(world.metadata.lastPlayed), date = new Date(time);
  addDetail('Last played', world.metadata.lastPlayed && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable');
  $('compatibility').textContent = world.metadata.policy.label;
  $('chunk-count').textContent = fmt(world.totals.chunks); $('region-count').textContent = fmt(world.totals.regions); $('dimension-count').textContent = world.totals.dimensions;
  $('project-location').textContent = `Project storage: ${value.projectDirectory}`;
  const select = $('dimension'); select.replaceChildren();
  for (const d of world.dimensions) {
    const option = document.createElement('option'); option.value = d.key;
    const name = { 'minecraft:overworld': 'Overworld', 'minecraft:the_nether': 'The Nether', 'minecraft:the_end': 'The End' }[d.id] ?? d.id;
    option.textContent = `${name} · ${fmt(d.chunkCount)} chunks${world.dimensions.filter(x => x.id === d.id).length > 1 ? ` (${d.layout})` : ''}`; select.append(option);
  }
  const notes = [...world.issues, ...value.project.warnings];
  for (const d of world.dimensions) { notes.push(...d.issues); for (const r of d.regions) notes.push(...r.issues.map(issue => `${r.path}: ${issue}`)); }
  $('issues').replaceChildren();
  for (const note of notes.slice(0, 500)) { const li = document.createElement('li'); li.textContent = note; $('issues').append(li); }
  if (notes.length > 500) { const li = document.createElement('li'); li.textContent = `Showing the first 500 of ${notes.length} notes.`; $('issues').append(li); }
  $('issue-count').textContent = notes.length;
  $('empty-state').hidden = true; $('closed').checked = false;
  changeDimension(); setBusy(false);
  status(`Inspected ${fmt(world.totals.chunks)} saved terrain chunks. Source world is unchanged.`);
}
async function openWorld() {
  if (dirty && !window.confirm('Open another world and discard unsaved protection changes?')) return;
  const result = await call(() => api.openWorld(), 'Choose a world folder…');
  if (result) load(result); else if (result === null) status('Folder selection canceled.');
}
$('open').onclick = $('open-empty').onclick = openWorld;
$('open-build-file').onclick=async()=>{const r=await call(()=>api.openBuildArchive(),'Opening portable build…');if(r)await window.openPortableBuild(r);else if(r===null)status('Build selection canceled.');};
$('rescan').onclick = async () => {
  if (dirty && !window.confirm('Rescan and discard unsaved protection changes?')) return;
  const result = await call(() => api.rescan(), 'Rescanning world…'); if (result) load(result);
};
function invalidateRegeneration() {
  regenerationReview = null; regenerationMarks.clear();
  $('regeneration-ack').checked = false;
  $('export-regeneration').disabled = true;
  $('regeneration-eligibility').textContent = 'Preview a selection to check export availability.';
  $('regeneration-legend').hidden = true;
  $('preview-result').textContent = 'Preview the current selection. No chunks will be deleted.';
  $('regeneration-details').hidden = true;
  $('save-regeneration').disabled = true;
  draw();
}
$('protection-buffer').onchange = () => { invalidateRegeneration(); draw(); };
function changeDimension() {
  invalidateRegeneration();
  if(dimension)dimensionSelections.set(dimension.key,selection);
  dimension = world?.dimensions.find(d => d.key === $('dimension').value) ?? null;
  chunks = dimension ? dimension.regions.flatMap(r => r.chunks) : []; selection=dimensionSelections.get(dimension?.key)??new Set();
  $('map-empty').hidden = chunks.length > 0 || dimension?.unreadableRegions?.length > 0 || !world; $('preview-result').textContent = 'Preview the chunks to remove from a separate copy.';
  configureTerrain(); fit(); updateSelection();
}
function configureTerrain() {
  const nether = dimension?.id === 'minecraft:the_nether', select = $('terrain-mode');
  select.replaceChildren();
  const modes = nether ? [['caverns', 'Cavern floors'], ['roof', 'Above roof · Y 128–255'], ['surface', 'Top surface (includes roof)'], ['cutaway', 'Below chosen Y']] : [['surface', 'Top surface'], ['cutaway', 'Below chosen Y']];
  for (const [value, label] of modes) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  const heights = terrainHeights[dimension?.id];
  $('terrain-y').min = heights?.minY ?? 0; $('terrain-y').max = heights?.maxY ?? 255; $('terrain-y').value = nether ? 64 : 80;
  resetTerrain();
}
function resetTerrain() {
  $('terrain-y-label').hidden = $('terrain-mode').value !== 'cutaway';
  terrain.reset(world, dimension, terrainSession, $('terrain-mode').value, Number($('terrain-y').value));
  $('terrain-note').textContent = $('terrain-mode').value === 'caverns'
    ? 'Nether cavern floors: highest surface below Y 128 with at least 3 air blocks above it. Smaller tunnels and covered floors can be hidden.'
    : $('terrain-mode').value === 'roof' ? 'Only Y 128–255. The bedrock roof and everything below it are excluded.'
    : $('terrain-mode').value === 'cutaway' ? 'Highest non-air block at or below the chosen Y. This is a cutaway projection, not a walkable-floor map.'
    : 'Top non-air blocks, including foliage and structures. Approximate material colors and elevation shading; vanilla heights only.';
  draw();
}
$('terrain-mode').onchange = resetTerrain;
$('terrain-y').onchange = () => {
  if (!$('terrain-y').checkValidity()) { status('Choose a whole height inside this dimension.', true); return; }
  resetTerrain();
};
$('dimension').onchange = changeDimension;
function updateSelection() {
  selectionBounds=selectionExtent(selection);topographic?.setSelection(selection,selectionBounds);
  $('map-selection-summary').textContent = selection.size ? `${fmt(selection.size)} chunks selected in this dimension · includes offscreen chunks` : 'No chunks selected in this dimension';
  $('clear-map-selection').disabled=busy||!selection.size;
  $('fit-selection').disabled = busy || !selection.size;
  $('selection-count').textContent = fmt(selection.size); $('protected-count').textContent = fmt(protectedChunks.size);
  for (const id of ['protect', 'unprotect', 'clear-selection', 'preview']) $(id).disabled = busy || selection.size === 0;
  $('copy').disabled = busy || !world || !$('closed').checked;
  $('save-regeneration').disabled = busy || !regenerationReview;
  $('export-regeneration').disabled = busy || !regenerationReview?.copyExport?.eligible || !$('closed').checked || !$('regeneration-ack').checked;
  $('regeneration-ack').disabled = busy;
  $('protection-buffer').disabled = busy || !world;
  $('save-state').textContent = !world ? 'No project yet' : dirty ? 'Unsaved changes' : 'Plan up to date';
  $('selection-fields').disabled = busy || !dimension;
}
function fit() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const extent = [...chunks, ...(dimension?.unreadableRegions ?? []).flatMap(r => [{ x: r.rx * 32, z: r.rz * 32 }, { x: r.rx * 32 + 31, z: r.rz * 32 + 31 }])];
  if (!extent.length) view = { x: 0, z: 0, scale: 16 };
  else {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const c of extent) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
    const scale = Math.max(0.000001, Math.min(128, (width - 70) / (maxX - minX + 1), (height - 70) / (maxZ - minZ + 1)));
    view = { scale, x: (minX + maxX + 1) / 2 - width / scale / 2, z: (minZ + maxZ + 1) / 2 - height / scale / 2 };
  }
  if(topographicActive)topographic.setLocation((view.x+width/view.scale/2)*16,(view.z+height/view.scale/2)*16,{resetScale:true});
  draw();
}
function ensureTopographic() {
  if(topographic?.unavailable)throw new Error('Reopen the app to retry the graphics context');
  if(topographic)return topographic;
  topographic=new TopographicMap($('topographic-map'),{
    onSelect:selectArea,
    onHover:p=>{if(!p){$('terrain-hover').textContent='Outside the loaded surface window.';return;}$('coordinates').textContent=`CHUNK ${p.x}, ${p.z} · BLOCK ${p.blockX}, ${p.blockZ}`;$('terrain-hover').textContent=terrain.describePoint(p.blockX,p.blockZ);},
    onNavigate:(x,z)=>{view.x=x/16-canvas.clientWidth/view.scale/2;view.z=z/16-canvas.clientHeight/view.scale/2;},
    onFailure:message=>{setMapView(false);status(message,true);},
    canInteract:()=>Boolean(world)&&!busy&&!window.transferBusy&&!window.templateBusy,
    tool:()=>$('map-tool').value
  });topographic.setSelection(selection,selectionBounds);return topographic;
}
function setMapView(enabled) {
  try {
    const cx=(view.x+canvas.clientWidth/view.scale/2)*16,cz=(view.z+canvas.clientHeight/view.scale/2)*16;
    if(enabled)ensureTopographic();
    topographicActive=enabled;topographic?.setActive(enabled);
    canvas.style.visibility=enabled?'hidden':'visible';
    for(const id of ['topographic-north','topographic-hint','topographic-overlay','view-scale-panel'])$(id).hidden=!enabled;
    $('map-container').classList.toggle('topographic-active',enabled);
    $('map-view').value=enabled?'topographic':'topdown';$('fit').textContent=enabled?'Center world':'Fit world';
    const orbit=$('map-tool').querySelector('[value="orbit"]');
    if(enabled&&!orbit){const option=document.createElement('option');option.value='orbit';option.textContent='Orbit';$('map-tool').append(option);}
    if(!enabled){if($('map-tool').value==='orbit')$('map-tool').value='select';orbit?.remove();}
    if(enabled)topographic.setLocation(cx,cz);draw();
  } catch(error){topographicActive=false;topographic?.setActive(false);$('map-view').value='topdown';$('topographic-map').hidden=true;for(const id of ['topographic-north','topographic-hint','topographic-overlay','view-scale-panel'])$(id).hidden=true;$('map-container').classList.remove('topographic-active');$('fit').textContent='Fit world';canvas.style.visibility='visible';status(`Topographic view unavailable: ${error.message}. Top-down remains available.`,true);draw();}
}
$('map-view').onchange=()=>setMapView($('map-view').value==='topographic');
$('topographic-north').onclick=()=>topographic?.north();
$('view-scale').oninput=()=>topographic?.setScale(Number($('view-scale').value));
$('view-scale-reset').onclick=()=>topographic?.resetScale();
function draw() {
  if(topographicActive){topographic.update(terrain,(x,z)=>selection.has(key(x,z))?(regenerationMarks.get(protectionKey(dimension?.key,x,z))??'#81caff'):protectedChunks.has(protectionKey(dimension?.key,x,z))?'#b9e6a1':null);return;}
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = '#101b1f'; ctx.fillRect(0, 0, width, height);
  terrain.paint(ctx, view, width, height);
  let step = view.scale >= 12 ? 1 : 32;
  while (step * view.scale < 50 && step !== 1) step *= 4;
  ctx.strokeStyle = view.scale >= 12 ? '#0b152d88' : '#7e92932a'; ctx.lineWidth = .7; ctx.beginPath();
  for (let x = Math.ceil(view.x / step) * step; x < view.x + width / view.scale; x += step) { const screen = (x - view.x) * view.scale; ctx.moveTo(screen, 0); ctx.lineTo(screen, height); }
  for (let z = Math.ceil(view.z / step) * step; z < view.z + height / view.scale; z += step) { const screen = (z - view.z) * view.scale; ctx.moveTo(0, screen); ctx.lineTo(width, screen); } ctx.stroke();
  // Outlines and light tint retain the recognizable terrain beneath selections.
  for (const c of protectedChunks.values()) if (c.dimension === dimension?.key) mark(c.x, c.z, '#b9e6a1', false);
  for (const k of selection) { const [x, z] = k.split(',').map(Number); mark(x, z, regenerationMarks.get(protectionKey(dimension.key, x, z)) ?? '#81caff', true); }
  function mark(cx, cz, color, selected) {
    const x = (cx - view.x) * view.scale, z = (cz - view.z) * view.scale;
    if (x + view.scale < 0 || z + view.scale < 0 || x > width || z > height) return;
    ctx.fillStyle = color; ctx.globalAlpha = selected ? .16 : .06; ctx.fillRect(x, z, view.scale, view.scale); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0a131c'; ctx.lineWidth = selected ? 4 : 3; ctx.strokeRect(x + 1, z + 1, Math.max(1, view.scale - 2), Math.max(1, view.scale - 2));
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 2.5 : 1.5; ctx.strokeRect(x + 1, z + 1, Math.max(1, view.scale - 2), Math.max(1, view.scale - 2));
    if (view.scale >= 48) { ctx.fillStyle = color; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(selected ? '✓' : '◇', x + 5, z + 14); }
  }
  ctx.textAlign = 'left'; ctx.font = '11px ui-monospace, monospace';
  const labelStep = Math.max(1, 2 ** Math.ceil(Math.log2(90 / view.scale)));
  for (let x = Math.ceil(view.x / labelStep) * labelStep; x < view.x + width / view.scale; x += labelStep) {
    const sx = (x - view.x) * view.scale; ctx.fillStyle = '#101b1fe8'; ctx.fillRect(sx + 2, 1, 70, 17); ctx.fillStyle = '#c5d8dc'; ctx.fillText(`X ${x * 16}`, sx + 5, 13);
  }
  for (let z = Math.ceil(view.z / labelStep) * labelStep; z < view.z + height / view.scale; z += labelStep) {
    const sz = (z - view.z) * view.scale; if (sz < 22) continue; ctx.fillStyle = '#101b1fe8'; ctx.fillRect(1, sz, 72, 17); ctx.fillStyle = '#c5d8dc'; ctx.fillText(`Z ${z * 16}`, 5, sz + 13);
  }
  ctx.fillStyle = '#101b1fe8'; ctx.fillRect(width - 115, height - 27, 110, 22); ctx.fillStyle = '#d4e5e9'; ctx.fillText(`↑ N · 16 blocks`, width - 109, height - 12);
  if (gesture && !gesture.pan) {
    const a = gesture.start, b = gesture.current; ctx.fillStyle = '#7fc5ff25'; ctx.strokeStyle = '#8bcaff'; ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
}
function point(event) { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
function worldPoint(p) { return { x: Math.floor(view.x + p.x / view.scale), z: Math.floor(view.z + p.y / view.scale) }; }
function selectArea(a, b) {
  invalidateRegeneration();
  selection=applyChunkRange(selection,chunks,a,b,$('selection-mode').value);
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
  $('x1').value = minX; $('x2').value = maxX; $('z1').value = minZ; $('z2').value = maxZ;
  updateSelection(); draw(); status(`${fmt(selection.size)} existing chunks selected.`);
}
canvas.onpointerdown = event => {
  if (!dimension || busy || ![0, 1, 2].includes(event.button)) return;
  canvas.setPointerCapture(event.pointerId); const p = point(event);
  gesture = { start: p, current: p, original: { ...view }, pan: event.shiftKey || event.button !== 0 || $('map-tool').value === 'pan' }; canvas.focus();
};
canvas.onpointermove = event => {
  const p = point(event), c = worldPoint(p);
  const bx = Math.floor((view.x + p.x / view.scale) * 16), bz = Math.floor((view.z + p.y / view.scale) * 16);
  $('coordinates').textContent = `CHUNK ${c.x}, ${c.z} · BLOCK ${bx}, ${bz}`;
  $('terrain-hover').textContent = terrain.describePoint(bx, bz);
  if (gesture) {
    gesture.current = p;
    if (gesture.pan) { view.x = gesture.original.x - (p.x - gesture.start.x) / view.scale; view.z = gesture.original.z - (p.y - gesture.start.y) / view.scale; }
    draw();
  }
};
canvas.onpointerup = event => {
  if (!gesture) return; if (!gesture.pan) selectArea(worldPoint(gesture.start), worldPoint(point(event)));
  gesture = null; draw();
};
canvas.oncontextmenu = event => event.preventDefault();
canvas.onpointercancel = () => { gesture = null; draw(); };
function zoom(factor, p = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }) {
  if (!world || busy) return;
  if(topographicActive){topographic.zoom(factor);return;}
  const scale = Math.max(.000001, Math.min(512, view.scale * factor));
  view.x += p.x / view.scale - p.x / scale; view.z += p.y / view.scale - p.y / scale; view.scale = scale; draw();
}
canvas.addEventListener('wheel', event => { if (!world || busy) return; event.preventDefault(); zoom(event.deltaY < 0 ? 1.18 : 1 / 1.18, point(event)); }, { passive: false });
canvas.onkeydown = event => {
  if (!world || busy) return;
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (directions[event.key]) { event.preventDefault(); const [x, z] = directions[event.key]; view.x += x * 60 / view.scale; view.z += z * 60 / view.scale; draw(); }
  if (event.key === '+' || event.key === '=') zoom(1.3); if (event.key === '-') zoom(1 / 1.3);
};
$('zoom-in').onclick = () => zoom(1.5); $('zoom-out').onclick = () => zoom(1 / 1.5); $('fit').onclick = fit;
$('fit-selection').onclick = () => {
  if (!selection.size) return;
  const chosen = selectedChunks();
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const c of chosen) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
  view.scale = Math.min(256, (canvas.clientWidth - 60) / (maxX - minX + 1), (canvas.clientHeight - 60) / (maxZ - minZ + 1));
  view.x = (minX + maxX + 1) / 2 - canvas.clientWidth / view.scale / 2; view.z = (minZ + maxZ + 1) / 2 - canvas.clientHeight / view.scale / 2; draw();
  if(topographicActive)topographic.fitSelection();
};
$('map-jump').onclick = () => {
  const x = Number($('map-x').value), z = Number($('map-z').value);
  if (![$('map-x').value.trim(), $('map-z').value.trim()].every(Boolean) || ![x, z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) { status('Enter whole block coordinates within ±30,000,000.', true); return; }
  view.scale = Math.max(32, view.scale); view.x = x / 16 - canvas.clientWidth / view.scale / 2; view.z = z / 16 - canvas.clientHeight / view.scale / 2; draw();
  if(topographicActive)topographic.setLocation(x,z);
};
$('select-area').onclick = () => {
  const values = ['x1', 'z1', 'x2', 'z2'].map(id => $(id).value.trim() === '' ? NaN : Number($(id).value));
  if (!values.every(Number.isSafeInteger)) { status('Enter whole, safe integer chunk coordinates.', true); return; }
  selectArea({ x: values[0], z: values[1] }, { x: values[2], z: values[3] });
};
$('clear-selection').onclick = () => { invalidateRegeneration(); selection.clear(); updateSelection(); draw(); };
$('clear-map-selection').onclick=$('clear-selection').onclick;
$('select-all').onclick=()=>{invalidateRegeneration();selection=new Set(chunks.map(c=>key(c.x,c.z)));updateSelection();draw();status(`All ${fmt(selection.size)} indexed chunks in this dimension selected, including offscreen chunks. Export and template limits apply separately.`);};
$('select-range').onclick=()=>{if($('protection-panel').hidden)$('toggle-protection').click();$('x1').focus();};
$('selection-mode').onchange=()=>{$('select-area').textContent={replace:'Replace selection with range',add:'Add range to selection',remove:'Remove range from selection'}[$('selection-mode').value];};
function selectedChunks() { return [...selection].map(k => { const [x, z] = k.split(',').map(Number); return { dimension: dimension.key, x, z }; }); }
$('protect').onclick = () => {
  invalidateRegeneration();
  if (protectedChunks.size + selection.size > 100000) { status('Protection plans are limited to 100,000 chunks in this preview.', true); return; }
  for (const c of selectedChunks()) protectedChunks.set(protectionKey(c.dimension, c.x, c.z), c);
  dirty = true; updateSelection(); draw(); status('Selection protected in the plan. Save the plan to keep these changes.');
};
$('unprotect').onclick = () => { invalidateRegeneration(); for (const c of selectedChunks()) protectedChunks.delete(protectionKey(c.dimension, c.x, c.z)); dirty = true; updateSelection(); draw(); };
$('save').onclick = async () => { const result = await call(() => api.saveProtection([...protectedChunks.values()]), 'Saving protection plan…'); if (result) { dirty = false; updateSelection(); status(`Plan saved outside the world: ${result.file}`); } };
$('preview').onclick = async () => {
  invalidateRegeneration();
  const result = await call(() => api.preview(selectedChunks(), [...protectedChunks.values()], Number($('protection-buffer').value)), 'Checking regeneration inputs…');
  if (result) {
    regenerationReview = result;
    $('regeneration-eligibility').textContent = result.copyExport.eligible ? 'Available for an experimental test copy.' : result.copyExport.blockers.join(' ');
    for (const c of result.candidates) regenerationMarks.set(protectionKey(c.dimension, c.x, c.z), '#edaa69');
    for (const c of [...result.excludedProtected, ...result.excludedBuffer]) regenerationMarks.set(protectionKey(c.dimension, c.x, c.z), '#b9e6a1');
    $('regeneration-legend').hidden = false;
    draw();
    $('preview-result').textContent = `${fmt(result.candidates.length)} candidate chunks · ${fmt(result.excludedProtected.length)} protected chunks excluded · ${fmt(result.excludedBuffer.length)} buffer chunks excluded. ${result.blockers.length ? 'Review has blockers.' : 'Review only.'} No chunks will be deleted.`;
    const counts = result.counts.records;
    $('regeneration-counts').textContent = `${fmt(counts.region)} terrain · ${fmt(counts.entities)} entity · ${fmt(counts.poi)} POI records · ${fmt(counts.external)} external payloads. ${fmt(result.counts.inspectedRegionFiles)} region files inspected. Record counts are not counts of mobs or points of interest.`;
    $('regeneration-findings').replaceChildren();
    const findings = [...new Set([...result.blockers, ...result.copyExport.blockers])].map(message => `Export blocked: ${message}`).concat(result.warnings);
    for (const message of findings.slice(0, 100)) { const li = document.createElement('li'); li.textContent = message; $('regeneration-findings').append(li); }
    if (findings.length > 100) { const li = document.createElement('li'); li.textContent = 'More findings are included in the saved report.'; $('regeneration-findings').append(li); }
    $('regeneration-details').hidden = false;
    $('regeneration-details').open = true;
    updateSelection();
    status('Dry-run complete. No world files were changed. A verified backup remains mandatory before any future write.');
  }
};
$('save-regeneration').onclick = async () => {
  const result = await call(() => api.saveRegenerationReview(regenerationReview?.reviewDigest), 'Rechecking inputs and saving dry-run report…');
  if (result) status(`Dry-run report saved outside the world: ${result.file}`);
  else invalidateRegeneration();
};
$('closed').onchange = updateSelection;
$('regeneration-ack').onchange = updateSelection;
$('export-regeneration').onclick = async () => {
  const result = await call(() => api.exportRegeneration({ reviewDigest: regenerationReview?.reviewDigest, confirmedClosed: $('closed').checked, confirmedExperimental: $('regeneration-ack').checked }), 'Creating backup and regeneration test copy…');
  if (result === null) { status('Export canceled.'); return; }
  invalidateRegeneration(); updateSelection();
  if (result) {
    $('regeneration-result').textContent = `Removed ${fmt(result.removedChunks)} chunks from the test copy. A verified backup is saved alongside it. Your original is unchanged.`;
    $('regeneration-result').title = `Export: ${result.world}\nBackup: ${result.backup}`;
    $('reveal-regeneration').hidden = false;
    status(`Regeneration test copy exported. Original unchanged. ${result.world}`);
  }
};
$('reveal-regeneration').onclick = () => call(() => api.revealRegeneration(), 'Showing exported world…');
$('copy').onclick = async () => {
  const result = await call(() => api.createCopy($('closed').checked), 'Choose where to store the verified copy…');
  if (result) status(`Verified ${fmt(result.files)} files. Copy: ${result.world}`); else if (result === null) status('Copy canceled.');
};
api.onProgress(progress => { if (busy) status(`${progress.phase}${progress.file ? ` · ${progress.file}` : ''}${progress.total ? ` (${progress.completed}/${progress.total})` : ''}`); });
window.addEventListener('beforeunload', event => { if (dirty || busy || window.transferBusy || window.templateBusy) { event.preventDefault(); event.returnValue = ''; } });
$('open-transfer').onclick = () => {
  const chosen = selectedChunks();
  let area = null;
  if (chosen.length) { const xs=chosen.reduce((b,c)=>({minX:Math.min(b.minX,c.x*16),maxX:Math.max(b.maxX,c.x*16+15),minZ:Math.min(b.minZ,c.z*16),maxZ:Math.max(b.maxZ,c.z*16+15)}),{minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity}); area=xs; }
  window.openTransferPlanner({ world, dimension: dimension?.key, area });
};
new ResizeObserver(draw).observe(canvas); draw();
$('toggle-protection').onclick = () => {
  const open = !$('protection-panel').hidden;
  $('protection-panel').hidden = open;
  $('toggle-protection').setAttribute('aria-expanded', String(!open));
  document.body.classList.toggle('show-protection', !open);
};
