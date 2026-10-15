/* Renderer has no filesystem access. The narrow preload bridge owns all requests. */
const $ = id => document.getElementById(id), api = window.worldrenew;
let world = null, dimension = null, chunks = [], protectedChunks = new Map(), selection = new Set(), dirty = false, busy = false;
let regenerationReview = null, regenerationMarks = new Map();
let view = { x: 0, z: 0, scale: 8 }, gesture = null;
const canvas = $('map'), ctx = canvas.getContext('2d');
const key = (x, z) => `${x},${z}`;
const protectionKey = (dimension, x, z) => `${dimension}:${x},${z}`;
const fmt = value => value.toLocaleString();
function status(message, error = false) { $('status').textContent = message; $('status').title = message; document.querySelector('.statusbar').classList.toggle('error', error); }
function setBusy(value) {
  busy = value; document.body.classList.toggle('busy', value);
  $('open-build-file').disabled=value;
  $('open').disabled = $('open-empty').disabled = value;
  $('open-transfer').disabled = value || !world;
  for (const id of ['rescan', 'dimension', 'fit', 'zoom-in', 'zoom-out', 'selection-fields', 'save']) $(id).disabled = value || !world;
  updateSelection();
}
async function call(action, loading) {
  setBusy(true); status(loading);
  try { const response = await action(); if (response.error) throw new Error(response.error.message); return response.result; }
  catch (error) { status(error.message, true); return undefined; }
  finally { setBusy(false); }
}
function addDetail(name, value) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value ?? 'Unavailable'; $('metadata').append(dt, dd); }
function load(value) {
  world = value.report; protectedChunks = new Map(value.project.protection.map(c => [protectionKey(c.dimension, c.x, c.z), c])); dirty = false;
  $('world-name').textContent = world.metadata.name; $('world-path').textContent = world.root; $('world-path').title = world.root;
  $('metadata').replaceChildren();
  addDetail('Minecraft Java', world.metadata.version); addDetail('DataVersion', world.metadata.dataVersion); addDetail('Seed', world.metadata.seed);
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
  dimension = world?.dimensions.find(d => d.key === $('dimension').value) ?? null;
  chunks = dimension ? dimension.regions.flatMap(r => r.chunks) : []; selection.clear();
  $('map-empty').hidden = chunks.length > 0 || !world; $('preview-result').textContent = 'Preview the chunks to remove from a separate copy.';
  fit(); updateSelection();
}
$('dimension').onchange = changeDimension;
function updateSelection() {
  $('map-selection-summary').textContent = selection.size ? `${fmt(selection.size)} chunks selected for 3D preview` : 'Select an area for 3D preview';
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
  if (!chunks.length) view = { x: 0, z: 0, scale: 16 };
  else {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const c of chunks) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
    const scale = Math.max(0.000001, Math.min(28, (width - 70) / (maxX - minX + 1), (height - 70) / (maxZ - minZ + 1)));
    view = { scale, x: (minX + maxX + 1) / 2 - width / scale / 2, z: (minZ + maxZ + 1) / 2 - height / scale / 2 };
  }
  draw();
}
function draw() {
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = '#101b1f'; ctx.fillRect(0, 0, width, height);
  let step = view.scale >= 7 ? 1 : 32;
  while (step * view.scale < 20 && step !== 1) step *= 4;
  ctx.strokeStyle = '#203035'; ctx.lineWidth = 0.5; ctx.beginPath();
  for (let x = Math.ceil(view.x / step) * step; x < view.x + width / view.scale; x += step) { const screen = (x - view.x) * view.scale; ctx.moveTo(screen, 0); ctx.lineTo(screen, height); }
  for (let z = Math.ceil(view.z / step) * step; z < view.z + height / view.scale; z += step) { const screen = (z - view.z) * view.scale; ctx.moveTo(0, screen); ctx.lineTo(width, screen); } ctx.stroke();
  const gap = view.scale >= 5 ? Math.min(1.5, view.scale * .13) : 0;
  for (const c of chunks) {
    const x = (c.x - view.x) * view.scale, y = (c.z - view.z) * view.scale;
    if (x + view.scale < 0 || y + view.scale < 0 || x > width || y > height) continue;
    ctx.fillStyle = !c.valid ? '#d98377' : protectedChunks.has(protectionKey(dimension.key, c.x, c.z)) ? '#b9e6a1' : '#3b7872';
    ctx.fillRect(x + gap / 2, y + gap / 2, Math.max(1, view.scale - gap), Math.max(1, view.scale - gap));
    if (selection.has(key(c.x, c.z))) { ctx.fillStyle = regenerationMarks.get(protectionKey(dimension.key, c.x, c.z)) ?? '#70bdff'; ctx.globalAlpha = .72; ctx.fillRect(x, y, Math.max(1, view.scale), Math.max(1, view.scale)); ctx.globalAlpha = 1; }
  }
  if (gesture && !gesture.pan) {
    const a = gesture.start, b = gesture.current; ctx.fillStyle = '#7fc5ff25'; ctx.strokeStyle = '#8bcaff'; ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
}
function point(event) { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
function worldPoint(p) { return { x: Math.floor(view.x + p.x / view.scale), z: Math.floor(view.z + p.y / view.scale) }; }
function selectArea(a, b) {
  invalidateRegeneration();
  selection.clear();
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
  for (const c of chunks) if (c.x >= minX && c.x <= maxX && c.z >= minZ && c.z <= maxZ) selection.add(key(c.x, c.z));
  $('x1').value = minX; $('x2').value = maxX; $('z1').value = minZ; $('z2').value = maxZ;
  updateSelection(); draw(); status(`${fmt(selection.size)} existing chunks selected.`);
}
canvas.onpointerdown = event => {
  if (!dimension || busy || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId); const p = point(event);
  gesture = { start: p, current: p, original: { ...view }, pan: event.shiftKey }; canvas.focus();
};
canvas.onpointermove = event => {
  const p = point(event), c = worldPoint(p);
  $('coordinates').textContent = `CHUNK ${c.x}, ${c.z} · BLOCK ${c.x * 16}, ${c.z * 16}`;
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
canvas.onpointercancel = () => { gesture = null; draw(); };
function zoom(factor, p = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }) {
  if (!world || busy) return;
  const scale = Math.max(.000001, Math.min(64, view.scale * factor));
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
$('select-area').onclick = () => {
  const values = ['x1', 'z1', 'x2', 'z2'].map(id => $(id).value.trim() === '' ? NaN : Number($(id).value));
  if (!values.every(Number.isSafeInteger)) { status('Enter whole, safe integer chunk coordinates.', true); return; }
  selectArea({ x: values[0], z: values[1] }, { x: values[2], z: values[3] });
};
$('clear-selection').onclick = () => { invalidateRegeneration(); selection.clear(); updateSelection(); draw(); };
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
window.addEventListener('beforeunload', event => { if (dirty || busy || window.transferBusy) { event.preventDefault(); event.returnValue = ''; } });
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
