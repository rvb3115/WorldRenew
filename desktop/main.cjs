const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

app.setName('WorldRenew');
if (process.env.WORLDRENEW_USER_DATA) app.setPath('userData', path.resolve(process.env.WORLDRENEW_USER_DATA));
let win, current = null, busy = false, updater;
let portableBuild=null,portableReview=null,lastPlacedCopy=null;
let textureSource = null, regenerationReview = null, lastRegeneratedCopy = null;
let destination = null, transfer = null, capturedBuild = null;
const workers = new Set();
const { TerrainService } = require('./terrain-service.cjs');
let terrain = null, terrainSession = 0;
const page = path.join(__dirname, '../ui/index.html');
function runWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: data }); workers.add(worker);
    let settled = false;
    worker.on('message', value => {
      if (value.progress) { if (win && !win.isDestroyed()) win.webContents.send('world:progress', value.progress); }
      else { settled = true; value.error ? reject(Object.assign(new Error(value.error.message), { code: value.error.code })) : resolve(value.result); }
    });
    worker.on('error', reject);
    worker.on('exit', code => { workers.delete(worker); if (!settled) reject(new Error(`Inspection worker stopped (${code}).`)); });
  });
}
function handle(name, action) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) return { error: { message: 'Untrusted request.' } };
    if (busy || updater?.running) return { error: { message: 'Wait for the current operation to finish.' } };
    busy = true;
    try { return { result: await action(...args) }; }
    catch (error) { return { error: { code: error.code || 'IO_ERROR', message: error.message } }; }
    finally { busy = false; }
  });
}
app.whenReady().then(async () => {
  const { loadProject, saveProject } = await import('../engine/projects.js');
  const { projectDirectoryOutsideWorld } = await import('../engine/projects.js');
  const { loadSelections, saveSelection } = await import('../engine/selections.js');
  const { installedTextureSource, AssetArchive } = await import('../engine/assets.js');
  const { UpdateService } = await import('../updates/service.js');
  updater = new UpdateService({
    directory: path.join(app.getPath('userData'), 'updates'),
    config: require('../updates/release-config.json'), currentVersion: app.getVersion(),
    isWorldBusy: () => busy || workers.size > 0
  });
  // Separate narrow routes: no renderer-supplied URL, package path, key or executable.
  for (const [name, action] of Object.entries({
    status: () => updater.status(), settings: value => updater.saveSettings(value),
    check: () => updater.check(), download: () => updater.stage(),
    reveal: async () => { shell.showItemInFolder(await updater.verifiedStagedFile()); return updater.status(); }
  })) ipcMain.handle(`updates:${name}`, async (event, value) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) return { error: { message: 'Untrusted request.' } };
    if (busy || workers.size) return { error: { message: 'Wait for the current world operation to finish.' } };
    try { return { result: await action(value) }; }
    catch (error) { return { error: { message: error.message } }; }
  });
  const templates = path.join(app.getPath('userData'), 'templates');
  const openWorldRoots = () => [current?.root, destination?.root].filter(Boolean);
  const usePortable = result => { portableBuild = { file: result.file, digest: result.digest }; portableReview = null; return result; };
  const projects = path.join(app.getPath('userData'), 'projects');
  const inspect = async folder => {
    const report = await runWorker({ action: 'inspect', folder });
    let project;
    try { project = loadProject(projects, report); }
    catch (error) { project = { protection: [], warnings: [`Project could not be loaded: ${error.message}`] }; }
    terrain?.dispose(); terrain = new TerrainService(report); terrainSession++;
    current = report; regenerationReview = null; transfer = null; capturedBuild = null; portableBuild=null;portableReview=null; return { report, project, projectDirectory: projects, terrainSession };
  };
  ipcMain.handle('terrain:tiles', async (event, request) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) return { error: { message: 'Untrusted request.' } };
    if (!terrain || request?.session !== terrainSession) return { error: { code: 'TERRAIN_SESSION', message: 'World changed. Refresh the terrain view.' } };
    if (busy || updater?.running) return { error: { code: 'TERRAIN_BUSY', message: 'World operation in progress.' } };
    try { return { result: await terrain.load(request) }; }
    catch (error) { return { error: { code: error.code || 'IO_ERROR', message: error.message } }; }
  });
  handle('textures:choose', async () => {
    const choice=await dialog.showOpenDialog(win,{title:'Choose a Minecraft client JAR or resource-pack ZIP',properties:['openFile'],filters:[{name:'Minecraft textures',extensions:['jar','zip']}]});
    if(choice.canceled)return null;const archive=new AssetArchive(choice.filePaths[0]);archive.close();textureSource={file:choice.filePaths[0],label:path.basename(choice.filePaths[0])};return {label:textureSource.label};
  });
  handle('textures:load', async data => {
    const palette=data?.palette,version=typeof data?.version==='string'?data.version:current?.metadata.version;
    const installed=installedTextureSource(app.getPath('home'),process.platform,version);
    const source=textureSource??installed;
    if(!source)return {unavailable:true,message:'No installed textures found. Choose a Minecraft client JAR or resource-pack ZIP.'};
    const result=await runWorker({action:'textures',file:source.file,palette,fallbackFile:textureSource?installed?.file:null});return {...result,label:source.label,version:source.version,worldVersion:version};
  });
  handle('world:open', async () => {
    // Explicit CLI path supports repeatable local smoke tests without bypassing the engine.
    const arg = process.argv.find(a => a.startsWith('--world='));
    if (arg && !current) return inspect(arg.slice('--world='.length));
    const choice = await dialog.showOpenDialog(win, { title: 'Choose a Minecraft Java world folder', properties: ['openDirectory'] });
    return choice.canceled ? null : inspect(choice.filePaths[0]);
  });
  handle('world:rescan', async () => { if (!current) throw new Error('Open a world first.'); return inspect(current.root); });
  handle('project:save', protection => { if (!current) throw new Error('Open a world first.'); return saveProject(projects, current, protection); });
  handle('plan:preview', async data => {
    if (!current) throw new Error('Open a world first.');
    regenerationReview = null;
    regenerationReview = await runWorker({ action: 'regeneration-review', world: current, selected: data?.selected, protection: data?.protection, options: { bufferChunks: data?.bufferChunks ?? 1 } });
    return regenerationReview;
  });
  handle('plan:save', async reviewDigest => {
    if (!current || !regenerationReview || reviewDigest !== regenerationReview.reviewDigest) throw new Error('Preview the current selection before saving a report.');
    const directory = path.join(projects, 'regeneration-previews');
    try { return await runWorker({ action: 'regeneration-save', directory, world: current, review: regenerationReview }); }
    catch (error) { regenerationReview = null; throw error; }
  });
  handle('plan:export', async data => {
    if (!current || !regenerationReview || data?.reviewDigest !== regenerationReview.reviewDigest) throw new Error('Preview the current selection before exporting.');
    if (!regenerationReview.copyExport.eligible) throw new Error(regenerationReview.copyExport.blockers.join(' '));
    if (data.confirmedClosed !== true || data.confirmedExperimental !== true) throw new Error('Confirm Minecraft is closed and review the experimental export notice.');
    const choice = await dialog.showOpenDialog(win, { title: 'Choose a folder for the backup and regeneration test copy', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return null;
    try {
      lastRegeneratedCopy = await runWorker({ action: 'regeneration-export', world: current, review: regenerationReview, parent: choice.filePaths[0], options: { confirmedClosed: true, confirmedExperimental: true } });
      return lastRegeneratedCopy;
    } finally { regenerationReview = null; }
  });
  handle('plan:reveal', () => { if (!lastRegeneratedCopy) throw new Error('Create a regeneration test copy first.'); shell.showItemInFolder(lastRegeneratedCopy.world); return true; });
  handle('world:copy', async confirmedClosed => {
    if (!current) throw new Error('Open a world first.');
    if (confirmedClosed !== true) throw new Error('Confirm Minecraft is closed before copying.');
    const choice = await dialog.showOpenDialog(win, { title: 'Choose a folder for the verified copy', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return null;
    return runWorker({ action: 'copy', folder: current.root, parent: choice.filePaths[0], options: { confirmedClosed: true } });
  });
  handle('templates:list', options => runWorker({ action: 'template-list', directory: templates, options, worlds: openWorldRoots() }));
  handle('templates:folder', async () => {
    const { ensureTemplateDirectory } = await import('../engine/template-library.js');
    const directory = ensureTemplateDirectory(templates, openWorldRoots());
    const error = await shell.openPath(directory); if (error) throw new Error(error); return { directory };
  });
  const importTemplateFile = async file => runWorker({ action: 'template-import', directory: templates, file, worlds: openWorldRoots() });
  const chooseTemplate = async () => {
    const choice = await dialog.showOpenDialog(win, { title: 'Import a portable template to this device', properties: ['openFile'], filters: [{ name: 'WorldRenew template', extensions: ['wrbuild'] }] });
    return choice.canceled ? null : choice.filePaths[0];
  };
  handle('templates:import', async () => { const file = await chooseTemplate(); return file ? importTemplateFile(file) : null; });
  handle('templates:drop', file => importTemplateFile(file));
  handle('templates:open', async id => usePortable(await runWorker({ action: 'template-open', directory: templates, id })));
  handle('templates:save', async name => {
    if (!current || !capturedBuild?.complete) throw new Error('Load a complete selection first.');
    return usePortable(await runWorker({ action: 'template-save', directory: templates, name, world: current, dimension: capturedBuild.dimension, bounds: capturedBuild.bounds, expectedDigest: capturedBuild.digest, worlds: openWorldRoots() }));
  });
  handle('templates:export', async id => {
    let source;
    if (id !== null) { const { templatePath } = await import('../engine/template-library.js'); source = templatePath(templates, id); }
    else { if (!portableBuild) throw new Error('Open a template first.'); source = portableBuild.file; }
    const choice = await dialog.showSaveDialog(win, { title: 'Export a template for another device', defaultPath: path.join(app.getPath('downloads'), path.basename(source)), filters: [{ name: 'WorldRenew template', extensions: ['wrbuild'] }] });
    if (choice.canceled) return null;
    return runWorker({ action: 'template-export', file: source, destination: choice.filePath, worlds: openWorldRoots() });
  });
  handle('archive:save',async()=>{
    if(!current||!capturedBuild?.complete)throw new Error('Load a complete selection first.');
    const choice=await dialog.showSaveDialog(win,{title:'Save portable build outside Minecraft saves',defaultPath:'My-build.wrbuild',filters:[{name:'WorldRenew build',extensions:['wrbuild']}]});if(choice.canceled)return null;
    const result=await runWorker({action:'archive-save',file:choice.filePath,world:current,dimension:capturedBuild.dimension,bounds:capturedBuild.bounds,expectedDigest:capturedBuild.digest,worlds:[current.root,...(destination?[destination.root]:[])]});
    const local = await importTemplateFile(result.file);
    usePortable(local); return { ...local, exportedFile: result.file };
  });
  handle('archive:open', async () => {
    const file = await chooseTemplate(); return file ? usePortable(await importTemplateFile(file)) : null;
  });
  handle('archive:preview',async data=>{
    if(!portableBuild||!destination)throw new Error('Open a portable build and destination first.');portableReview=null;
    const protection=loadProject(projects,destination).protection;
    const result=await runWorker({action:'archive-preview',file:portableBuild.file,destination,destinationDimension:data?.destinationDimension,anchor:data?.anchor,protection});
    if(result.archiveDigest!==portableBuild.digest)throw new Error('Build file changed. Reopen it before reviewing placement.');
    if(result.copyEligible)portableReview={dimension:data.destinationDimension,anchor:data.anchor,reviewDigest:result.reviewDigest};return result;
  });
  handle('archive:place',async data=>{
    if(!portableBuild||!portableReview||!destination||data?.reviewDigest!==portableReview.reviewDigest)throw new Error('Review an eligible placement first.');
    if(data.confirmedClosed!==true)throw new Error('Confirm Minecraft and servers are closed.');
    const choice=await dialog.showOpenDialog(win,{title:'Choose a folder for the backup and separate test world',properties:['openDirectory','createDirectory']});if(choice.canceled)return null;
    const protection=loadProject(projects,destination).protection;
    const result=await runWorker({action:'archive-place',file:portableBuild.file,destination,destinationDimension:portableReview.dimension,anchor:portableReview.anchor,parent:choice.filePaths[0],options:{confirmedClosed:true,reviewDigest:portableReview.reviewDigest,protection}});portableReview=null;lastPlacedCopy=result;return result;
  });
  handle('archive:reveal',()=>{if(!lastPlacedCopy)throw new Error('Create a test copy first.');shell.showItemInFolder(lastPlacedCopy.world);return true;});
  handle('build:capture', async data => {
    if (!current) throw new Error('Open a source world first.');
    transfer = null;
    capturedBuild = null;portableBuild=null;portableReview=null;
    capturedBuild = await runWorker({ action: 'capture', world: current, dimension: data?.dimension, bounds: data?.bounds });
    return capturedBuild;
  });
  handle('build:selections', () => { if (!current) throw new Error('Open a world first.'); return loadSelections(path.join(projects, 'selections'), current); });
  handle('build:selection-save', name => { if (!current) throw new Error('Open a world first.'); const directory=path.join(projects,'selections'); if(destination) projectDirectoryOutsideWorld(directory,destination); return saveSelection(directory,current,capturedBuild,name); });
  handle('build:view-source', data => { if (!current) throw new Error('Open a source world first.'); return runWorker({action:'capture',world:current,dimension:data?.dimension,bounds:data?.bounds}); });
  handle('build:view-destination', data => { if (!destination) throw new Error('Open a destination first.'); return runWorker({action:'capture',world:destination,dimension:data?.dimension,bounds:data?.bounds}); });
  handle('build:destination', async () => {
    if (!current&&!portableBuild) throw new Error('Open a source world or portable build first.');
    const choice = await dialog.showOpenDialog(win, { title: 'Choose a destination world for preview only', properties: ['openDirectory'] });
    if (choice.canceled) return null;
    const report = await runWorker({ action: 'inspect', folder: choice.filePaths[0] });
    destination = report; transfer = null;portableReview=null; return report;
  });
  handle('build:preview', async data => {
    if (!current || !destination) throw new Error('Open both source and destination worlds.');
    transfer = null;
    const result = await runWorker({ action: 'transfer', world: current, dimension: data?.dimension, bounds: data?.bounds, destination, destinationDimension: data?.destinationDimension, anchor: data?.anchor });
    // Keep only a review manifest, not potentially large voxel arrays, in the coordinator.
    const describe = volume => ({ world: volume.root, dimension: volume.dimension, version: volume.version, dataVersion: volume.dataVersion, bounds: volume.bounds, digest: volume.digest, stats: volume.stats, complete: volume.complete, snapshots: volume.snapshots, issues: volume.issues });
    transfer = { schemaVersion: 1, executable: false, mode: result.mode, createdAt: new Date().toISOString(), source: describe(result.source), destination: describe(result.destination), anchor: result.anchor, counts: result.counts, boundary: result.boundary, portals: result.portals, blockers: result.blockers, warnings: result.warnings };
    return result;
  });
  handle('build:save', () => {
    if (!transfer || !current || !destination) throw new Error('Run a placement preview first.');
    const directory = projectDirectoryOutsideWorld(projectDirectoryOutsideWorld(path.join(projects, 'transfer-previews'), current), destination);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}.worldrenew-plan.json`);
    fs.writeFileSync(file, JSON.stringify(transfer, null, 2), { flag: 'wx', mode: 0o600 }); return { file };
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  function createWindow() {
    win = new BrowserWindow({ width: 1440, height: 950, minWidth: 1080, minHeight: 760, title: 'WorldRenew', backgroundColor: '#0d1518', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-prevent-unload', event => {
      if (busy) { dialog.showMessageBoxSync(win, { type: 'info', message: 'An operation is still running.', detail: 'Wait for inspection or copy verification to finish before closing.', buttons: ['Keep open'] }); return; }
      const choice = dialog.showMessageBoxSync(win, { type: 'question', message: 'Discard unsaved protection changes?', buttons: ['Keep open', 'Discard changes'], defaultId: 0, cancelId: 0 });
      if (choice === 1) event.preventDefault();
    });
    win.loadFile(page);
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'WorldRenew', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] }
  ]));
  createWindow();
  // One startup check, deferred while world work is active. No install/restart hook exists.
  const startupCheck = setInterval(async () => {
    if (busy || workers.size || updater.running) return;
    clearInterval(startupCheck);
    try { await updater.check({ automatic: true }); } catch { /* Available in update status. */ }
    if (win && !win.isDestroyed()) win.webContents.send('updates:changed', updater.status());
  }, 10000);
  startupCheck.unref();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { terrain?.dispose(); if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => terrain?.dispose());
app.on('before-quit', event => {
  if (busy) { event.preventDefault(); dialog.showMessageBoxSync(win, { type: 'info', message: 'Wait for the current operation to finish before quitting.', buttons: ['Keep open'] }); }
});
