(() => {
  const $ = id => document.getElementById(id), api = window.worldrenew, dialog = $('templates-dialog');
  let working = false, offset = 0, next = null;
  function status(text, error = false) { $('templates-status').textContent = text; $('templates-status').classList.toggle('error', error); }
  function controls() {
    window.templateBusy = working;
    for (const button of dialog.querySelectorAll('button')) button.disabled = working || button.dataset.invalid === 'true';
    $('templates-cancel').hidden=!working;$('templates-cancel').disabled=!working;
    $('templates-previous').disabled = working || offset === 0; $('templates-next').disabled = working || next === null;
  }
  async function run(action) {
    if (working) return;
    working = true; controls();
    try { const response = await action(); if (response.error) throw new Error(response.error.message); return response.result; }
    catch (error) { status(error.message, true); return undefined; }
    finally { working = false; controls(); }
  }
  async function refresh() {
    const result = await run(() => api.listTemplates({ offset, limit: 50 })); if (!result) return;
    next = result.nextOffset; $('templates-directory').textContent = `Stored on this device: ${result.directory}`;
    $('templates-page').textContent = result.total ? `${offset + 1}–${offset + result.items.length} of ${result.total}${result.truncated ? '+' : ''}` : 'No templates saved yet';
    $('templates-list').replaceChildren();
    for (const item of result.items) {
      const row = document.createElement('div'); row.className = 'template-row'; row.dataset.id = item.id;
      const info = document.createElement('div'); info.className = 'template-info';
      const title = document.createElement('strong'); title.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = item.error ?? `${(item.bytes / 1024).toFixed(1)} KB · ${item.id} · validated on open`;
      info.append(title, detail); row.append(info);
      const open = document.createElement('button'); open.textContent = 'Open'; open.dataset.invalid = String(Boolean(item.error));
      open.onclick = async () => {
        status('Validating template…'); const archive = await run(() => api.openTemplate(item.id));
        if (archive) { dialog.close(); await window.openPortableBuild(archive); }
      };
      const exportButton = document.createElement('button'); exportButton.textContent = 'Export…'; exportButton.dataset.invalid = open.dataset.invalid;
      exportButton.onclick = async () => {
        status('Choose a new filename for the exported copy…');
        const result = await run(() => api.exportTemplate(item.id));
        if (result) status(`Exported ${result.file}. Transfer that .wrbuild file, then choose Import on the other device.`);
        else if (result === null) status('Export canceled.');
      };
      row.append(open, exportButton); $('templates-list').append(row);
    }
    if (result.warnings.length || result.truncated) status([...result.warnings, ...(result.truncated ? ['Only the first 10,000 directory entries are listed. Move older files into a separate folder.'] : [])].join(' '));
    controls();
  }
  $('templates-open').onclick = async () => { dialog.showModal(); status('Templates are local to this device. Import a file or choose Create template from an open world.'); offset = 0; await refresh(); };
  $('templates-close').onclick = () => dialog.close(); dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  $('templates-refresh').onclick = refresh;
  $('templates-cancel').onclick=()=>{api.cancelTemplate();status('Cancellation requested. Any completed library copy remains available on Refresh.');};
  $('templates-previous').onclick = () => { offset = Math.max(0, offset - 50); refresh(); };
  $('templates-next').onclick = () => { if (next !== null) { offset = next; refresh(); } };
  $('templates-folder').onclick = async () => { const result = await run(() => api.openTemplatesFolder()); if (result) status(`Opened ${result.directory}`); };
  async function imported(result) {
    if (result) { offset = 0; await refresh(); status(`Imported ${result.id}. The original file is unchanged. Open the local copy below.`); }
    else if (result === null) status('Import canceled.');
  }
  $('templates-import').onclick = async () => { status('Choose a .wrbuild file to copy into your library…'); await imported(await run(() => api.importTemplate())); };
  document.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (dialog.open) $('templates-drop').classList.add('dragging'); }
  });
  document.addEventListener('dragleave', () => $('templates-drop').classList.remove('dragging'));
  document.addEventListener('drop', async event => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault(); $('templates-drop').classList.remove('dragging');
    if (working || document.body.classList.contains('busy') || window.transferBusy || $('build-dialog').open || $('template-editor').open || $('recovery-dialog').open) return;
    if (!dialog.open) dialog.showModal();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length !== 1 || !/\.wrbuild$/i.test(files[0].name)) { status('Drop one .wrbuild file.', true); return; }
    status('Validating and copying the dropped file…');
    await imported(await run(() => api.importDroppedTemplate(files[0])));
  });
})();
