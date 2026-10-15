(() => {
  const $ = id => document.getElementById(id), api = window.worldrenew;
  const canvas = $('build-canvas'), ctx = canvas.getContext('2d'), dialog = $('build-dialog');
  let framing;const framingReady=import('./preview-framing.js').then(module=>{framing=module;});
  let plannerEpoch=0,sourceEpoch=0,progressCurrent=()=>true;
  let textureLoading=false, textureRequest=0, textureKey='';
  let sourceView=null,portable=null;
  let spectator = null, destinationView = null, savedSelections = [], firstCorner = null, secondCorner = null, scanMatches = false;
  let sourceWorld = null, destinationWorld = null, captured = null, preview = null, displayed = null, overlay = null, working = false;
  let geometry = null, geometryKey = '', camera = { zoom: 1, x: 0, y: 0 }, drag = null, plane = null, frame = 0;
  const air = s => ['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(s?.Name);
  const at = (v,x,y,z) => y*v.size.x*v.size.z+z*v.size.x+x;
  const diffColors = ['#526b69','#91dfa6','#efb164','#ef7f88','#da9aeb','#80b5ef','#b8a5ee','#8aa7a9'];
  function status(text, error=false) { $('build-status').textContent=text; $('build-status').title=text; $('build-status').classList.toggle('error',error); }
  function controls() {
    const locked=working||textureLoading;window.transferBusy=locked;
    for(const id of ['choose-textures','use-textures','build-layer','step-source','step-destination','next-placement','pick-corners'])$(id).disabled=locked;
    for (const id of ['build-capture','build-open-destination','build-bounds','build-source-dimension','build-anchor','close-build']) $(id).disabled=locked;
    $('build-near-camera').disabled=locked||!displayed||!['source','destination'].includes($('build-layer').value)||$('build-view-mode').value!=='spectator';
    $('build-preview').disabled=locked||!destinationWorld; $('build-destination-dimension').disabled=locked||!destinationWorld;
    $('build-save').disabled=locked||!preview;
    $('build-selection-save').disabled=locked||!scanMatches||!captured?.complete;
    $('build-selection-load').disabled=locked||!$('build-library').value;
    $('build-view-destination').disabled=locked||!destinationWorld;
    for(const id of ['build-height','build-library','build-pick'])$(id).disabled=locked;
    for(const b of document.querySelectorAll('.build-nudges button'))b.disabled=locked||!destinationWorld;
    $('build-template-save').disabled=locked||!!portable||!scanMatches||!captured?.complete;
    $('build-template-name').disabled=locked||!!portable;
    $('build-template-export').hidden=!portable; $('build-template-export').disabled=locked;
    $('build-template-save').hidden=!!portable;
    $('build-archive-save').disabled=locked||!!portable||!scanMatches||!captured?.complete;
    for(const id of ['build-capture','build-source-dimension','build-bounds','build-height','pick-corners','build-selection-save','build-selection-load'])if(portable)$(id).disabled=true;
    $('selection-library').hidden=!!portable;$('build-archive-save').hidden=!!portable;$('pick-corners').hidden=!!portable;$('build-capture').hidden=!!portable;
    $('build-save').hidden=!!portable;
    if(portable&&$('build-layer').value==='source')$('build-near-camera').disabled=true;
    $('placement-air-mode').disabled=locked;
    $('placement-closed').disabled=locked||!preview?.copyEligible;
    $('build-place-copy').disabled=locked||!portable||!preview?.copyEligible||!$('placement-closed').checked;
    $('copy-eligibility').textContent=!portable?'Save or open a portable build to check copy placement.':!preview?'Preview this build at the destination first.':preview.copyEligible?'Ready for an experimental building-block copy. Review the carved and replaced blocks.':`Copy blocked: ${preview.blockers[0]??'Review the notes.'}`;

  }
  async function run(action,message,{isCurrent=()=>true}={}) {
    const epoch=plannerEpoch;
    progressCurrent=isCurrent;working=true;window.transferBusy=true;controls();status(message);
    try { const r=await action();if(epoch!==plannerEpoch||!isCurrent())return undefined;if(r.error)throw new Error(r.error.message);return r.result; }
    catch(e){if(epoch===plannerEpoch&&isCurrent())status(e.message,true);return undefined;}
    finally{if(epoch===plannerEpoch){working=false;window.transferBusy=false;controls();}}
  }
  function fillDimensions(select,world,value) {
    select.replaceChildren();for(const d of world.dimensions){const o=document.createElement('option');o.value=d.key;o.textContent=d.id.replace('minecraft:','').replaceAll('_',' ');select.append(o);} if(value)select.value=value;
  }
  function readBounds(){return Object.fromEntries(['minX','minY','minZ','maxX','maxY','maxZ'].map(k=>[k,$(`build-${k}`).value.trim()===''?NaN:Number($(`build-${k}`).value)]));}
  function readAnchor(){return Object.fromEntries(['x','y','z'].map(k=>[k,$(`build-anchor-${k}`).value.trim()===''?NaN:Number($(`build-anchor-${k}`).value)]));}
  function resetPreview() { preview=null;$('air-effect-counts').textContent='Run a fresh placement preview to see affected blocks.';$('placement-closed').checked=false;$('build-save').disabled=true;$('build-layer').value='source';displayed=captured;overlay=null;geometry=null;updateSpectator();render();controls(); }
  function clearSourceDisplay(){scanMatches=false;preview=null;captured=null;sourceView=null;displayed=null;overlay=null;geometry=null;plane=null;++textureRequest;$('build-layer').value='source';$('placement-closed').checked=false;$('build-hover').textContent='';$('build-placeholder').hidden=false;spectator?.clear();render();controls();}
  function invalidateSource() { ++sourceEpoch;clearSourceDisplay();$('build-summary').textContent='Selection changed. Scan again to see the updated blocks.';$('build-findings').replaceChildren();status('Selection changed. The previous preview was cleared.'); }
  function findText(lines) { $('build-findings').parentElement.querySelector('summary').textContent=`Review notes (${lines.length})`;$('build-findings').replaceChildren();for(const line of lines){const li=document.createElement('li');li.textContent=line;$('build-findings').append(li);} }
  function metrics(items) { $('build-summary').replaceChildren();for(const [label,value] of items){const d=document.createElement('div'),s=document.createElement('span'),n=document.createElement('strong');s.textContent=label;n.textContent=Number(value).toLocaleString();d.append(s,n);$('build-summary').append(d);} }
  function sourceFindings(v) {
    return [...v.issues,`${v.attachments.blockEntities.length} block entities and ${v.attachments.blockTicks.length+v.attachments.fluidTicks.length} scheduled ticks recorded for review. Moving them is not implemented.`,
      ...(v.stats.unknown?[`${v.stats.unknown.toLocaleString()} blocks have unknown data. They are shown in purple, never filled with air.`]:[]),
      ...(Object.values(v.boundaryNonAir).some(n=>n>0)?['Non-air blocks touch selection edges. Check roofs, foundations, tunnels and supports before choosing the final boundary.']:[]),
      'All source air is included. Automatic detection cannot decide which empty spaces belong to your build.',
      'Entities, biome transfer and terrain blending remain unimplemented. No save files were changed.'];
  }
  function showSource(v) { sourceView=null;scanMatches=true;captured=v;preview=null;$('build-layer').value='source';displayed=v;overlay=null;setupView();spectator?.fit(v.bounds);metrics([['NON-AIR BLOCKS',v.stats.nonAir],['AIR BLOCKS',v.stats.air],['UNKNOWN BLOCKS',v.stats.unknown]]);findText([framing.previewLocationText(v.dimension,v.bounds),...sourceFindings(v)]);controls(); }
  function setupView() {
    if(!displayed)return;camera={zoom:1,x:0,y:0};geometry=null;
    for(const [id,min,max] of [['build-y',displayed.bounds.minY,displayed.bounds.maxY],['build-z',displayed.bounds.minZ,displayed.bounds.maxZ]]){$(id).min=min;$(id).max=max;$(id).value=max;$(id).disabled=false;}
    $('build-placeholder').hidden=true;updateSpectator();render();loadPreviewTextures();
  }
  function composite(p) {
    if(!p.context){
      const offset=p.destination.palette.length,volume={...p.destination,palette:[...p.destination.palette,...p.source.palette],voxels:p.destination.voxels.slice()};
      for(let i=0;i<volume.voxels.length;i++)if(!(p.airMode==='skip'&&air(p.source.palette[p.source.voxels[i]])))volume.voxels[i]=offset+p.source.voxels[i];
      return {volume,codes:p.differences};
    }
    const v={...p.context,palette:[...p.context.palette],voxels:p.context.voxels.slice()}, codes=new Uint8Array(v.voxels.length);
    const map=p.source.palette.map((s,i)=>{if(!i)return 0;v.palette.push(s);return v.palette.length-1;});
    for(let y=0;y<p.source.size.y;y++)for(let z=0;z<p.source.size.z;z++)for(let x=0;x<p.source.size.x;x++){
      const si=at(p.source,x,y,z),di=at(v,x+p.anchor.x-v.bounds.minX,y+p.anchor.y-v.bounds.minY,z+p.anchor.z-v.bounds.minZ);
      if(!(p.airMode==='skip'&&air(p.source.palette[p.source.voxels[si]])))v.voxels[di]=map[p.source.voxels[si]];codes[di]=p.differences[si];
    }
    return {volume:v,codes};
  }
  function changeLayer() {
    const mode=$('build-layer').value;document.querySelector('.build-legend').hidden=mode!=='differences';
    if(mode==='source'){displayed=sourceView??captured;overlay=null;}
    else if(mode==='destination'&&destinationView&&!preview){displayed=destinationView;overlay=null;}
    else if(!preview){$('build-layer').value='source';status('Run a destination placement preview first.');return;}
    else if(mode==='destination'){displayed=preview.destination;overlay=null;}
    else {const c=composite(preview);displayed=c.volume;overlay=mode==='differences'?c.codes:null;}
    setupView();controls();
  }
  window.openTransferPlanner=async({world,dimension,area,archive=null})=>{
    await framingReady;
    if(!world?.dimensions?.some(d=>d.key===dimension)){status('The requested dimension is no longer available. Reopen the world and select its dimension.',true);return;}
    ++plannerEpoch;++sourceEpoch;++textureRequest;working=false;textureLoading=false;
    $('placement-air-mode').value='include'; updateAirPolicy();
    portable=archive;$('placement-closed').checked=false;$('placement-result').textContent='';$('reveal-placement').hidden=true;$('portable-summary').textContent=archive?`Portable build: ${archive.summary.name}. Frozen content; source world is not required. ${archive.summary.entities} entity groups and ${archive.summary.blockEntities} block entities preserved. Includes supporting data from entire intersecting chunks.`:'A portable build freezes blocks and air. It also contains nearby blocks, inventories and entities from the complete intersecting chunks.';
    textureKey='';sourceView=null;sourceWorld=world;destinationWorld=null;destinationView=null;firstCorner=null;secondCorner=null;scanMatches=false;captured=null;preview=null;displayed=null;overlay=null;geometry=null;
    $('build-source-name').textContent=world.metadata.name;fillDimensions($('build-source-dimension'),world,dimension);
    $('build-destination-name').textContent='No destination selected.';$('build-destination-dimension').replaceChildren();
    const d=world.dimensions.find(d=>d.key===dimension),overworld=d?.id==='minecraft:overworld';
    const x=Math.floor((world.metadata.spawn?.x??0)/16)*16,z=Math.floor((world.metadata.spawn?.z??0)/16)*16;
    const b=archive?archive.volume.bounds:{minX:x,maxX:x+15,minZ:z,maxZ:z+15,...area,minY:overworld?-64:0,maxY:overworld?319:255};
    for(const [key,value] of Object.entries(b))$(`build-${key}`).value=value;
    for(const [k,v] of [['x',b.minX],['y',b.minY],['z',b.minZ]])$(`build-anchor-${k}`).value=v;
    $('build-layer').value='source';$('build-summary').textContent='No block volume scanned yet.';$('build-placeholder').hidden=false;
    findText(['Select the full height of the build, including basements and floating sections.','This is a block and conflict preview. No transfer or terrain modification is performed.']);
    const epoch=plannerEpoch;setStep('source',false);controls();if(!dialog.open)dialog.showModal();render();heightOptions();await ensureSpectator();if(epoch!==plannerEpoch||!dialog.open)return;updateSpectator();if(archive){showSource(archive.volume);findText([archive.summary.coverage,'Portable file loaded independently of the source world. Unsupported contents remain preserved but cannot yet be placed.']);status('Portable build loaded. Choose a destination to review placement.');}else{await refreshLibrary();if(epoch===plannerEpoch&&dialog.open)await scanSource();}
  };
  window.openPortableBuild=async archive=>{if(archive.schema===2)return window.openStreamingTemplate(archive);const v=archive.volume;await window.openTransferPlanner({archive,world:{metadata:{name:archive.summary.name,version:v.version,dataVersion:v.dataVersion},dimensions:[{key:v.dimension,id:archive.summary.dimension}]},dimension:v.dimension});};
  $('build-archive-save').onclick=async()=>{const r=await run(()=>api.saveBuildArchive(),'Saving frozen blocks and supporting chunk records…');if(r){portable=r;for(const[k,v]of Object.entries(r.volume.bounds))$(`build-${k}`).value=v;showSource(r.volume);$('portable-summary').textContent=`Saved portable build: ${r.file}. Source world is no longer needed. Full supporting chunks include surrounding data.`;findText([r.summary.coverage,`${r.summary.blockEntities} block entities, ${r.summary.entities} entity groups and ${r.summary.ticks} scheduled updates preserved. Their relocation may be blocked.`]);status('Portable build saved and verified. Choose a destination to review it.');}else if(r===null)status('Build save canceled.');};
  $('build-template-save').onclick = async () => {
    const r = await run(() => api.saveTemplate($('build-template-name').value), 'Saving a verified template on this device…');
    if (!r) return;
    portable = r; showSource(r.volume);
    $('portable-summary').textContent = `Saved locally: ${r.file}. Use Templates → Open Templates Folder to find it, or Export to copy it to another device.`;
    findText([r.summary.coverage, 'The template is independent of the source world. Existing templates were not overwritten.']);
    status('Template saved locally and verified. Export the .wrbuild file to move it to another device.');
  };
  $('build-template-export').onclick = async () => {
    const result = await run(() => api.exportTemplate(null), 'Choose where to export the template…');
    if (result) status(`Template exported: ${result.file}. Import this file on another device.`);
    else if (result === null) status('Template export canceled.');
  };
  $('reveal-placement').onclick=()=>run(()=>api.revealPlacedCopy(),'Showing the created test world…');
  function updateAirPolicy() {
    $('placement-air-note').textContent = $('placement-air-mode').value === 'include'
      ? 'Captured air, cave air and void air clear destination space, including rooms and tunnels. Exterior air inside the selected box also clears blocks.'
      : 'Captured air, cave air and void air leave destination blocks unchanged. Underground rooms can remain filled.';
    $('air-effect-counts').textContent = 'Run a fresh placement preview to see affected blocks.';
  }
  function showAirEffects(result) {
    const a = result.effects.sourceAir;
    $('air-effect-counts').textContent = `${result.effects.changedBlocks.toLocaleString()} blocks change · ${result.counts.carved.toLocaleString()} cleared to air · ${result.counts.skippedAir.toLocaleString()} air positions skipped. Captured: ${a.air} air, ${a.caveAir} cave air, ${a.voidAir} void air; ${a.structureVoid} structure-void and ${a.unknown} unknown. Structure-void is not an air mask.`;
    $('air-effect-counts').dataset.changed = result.effects.changedBlocks;
    $('air-effect-counts').dataset.skipped = result.counts.skippedAir;
    $('air-effect-counts').dataset.carved = result.counts.carved;
  }
  $('placement-air-mode').onchange = () => { resetPreview(); updateAirPolicy(); status('Air placement changed. Review a fresh preview before creating a copy.'); };
  $('placement-closed').onchange=controls;
  $('build-place-copy').onclick=async()=>{if(!preview?.copyEligible)return;const r=await run(()=>api.createPlacedCopy({confirmedClosed:$('placement-closed').checked,reviewDigest:preview.reviewDigest}),'Creating a verified backup and separate test world…');if(r){$('placement-result').textContent=`Reviewed ${r.blocks.toLocaleString()} blocks; changed ${r.effects.changedBlocks.toLocaleString()} and skipped ${r.effects.skippedAir.toLocaleString()} air positions in a separate test world. Backup and validation report are in the same output folder.`;$('placement-result').title=`World: ${r.world}\nBackup: ${r.backup}\nValidation report: ${r.report}`;$('reveal-placement').hidden=false;preview=null;$('placement-closed').checked=false;controls();status('Test world copy created and validated. Original world and backup are unchanged. Test the copied world in Minecraft before relying on it.');}else if(r===null)status('Copy destination selection canceled.');};
  $('close-build').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{++plannerEpoch;++sourceEpoch;++textureRequest;working=false;textureLoading=false;window.transferBusy=false;spectator?.setActive(false);});dialog.addEventListener('cancel',e=>{if(working||textureLoading)e.preventDefault();});
  async function scanSource(){
    const epoch=plannerEpoch,scan=++sourceEpoch,request={root:sourceWorld?.root,dimension:$('build-source-dimension').value,bounds:readBounds()};clearSourceDisplay();
    await framingReady;if(epoch!==plannerEpoch||scan!==sourceEpoch||!dialog.open)return;
    try{const limit=framing.previewLimitMessage(request.bounds);if(limit)throw new Error(limit);}
    catch(error){status(error.message,true);$('build-summary').textContent='No block preview loaded for these bounds.';return;}
    Object.assign(dialog.dataset,{requestedDimension:request.dimension,requestedBounds:JSON.stringify(request.bounds)});
    const r=await run(()=>api.captureBuild({dimension:request.dimension,bounds:request.bounds}),'Scanning the requested source volume…',{isCurrent:()=>scan===sourceEpoch});
    const current={root:sourceWorld?.root,dimension:$('build-source-dimension').value,bounds:readBounds()};
    if(epoch!==plannerEpoch||scan!==sourceEpoch||!dialog.open||!framing.matchingPreviewRequest(request,current))return;
    if(r&&!framing.matchingPreview(r,request)){clearSourceDisplay();status('The returned scan belongs to a different world, dimension or selection. Scan again; no mismatched area is displayed.',true);return;}
    if(r){showSource(r);status(`Read ${r.stats.total.toLocaleString()} blocks. ${r.complete?'Block selection is complete.':'Selection has missing data or metadata issues.'} ${framing.previewLocationText(r.dimension,r.bounds)}`);}return r;
  }
  $('build-capture').onclick=scanSource;
  $('build-open-destination').onclick=async()=>{
    const r=await run(()=>api.openDestination(),'Choose a destination world…');
    if(r){destinationWorld=r;destinationView=null;fillDimensions($('build-destination-dimension'),r,r.dimensions.find(d=>d.id===sourceWorld.dimensions.find(d=>d.key===$('build-source-dimension').value)?.id)?.key);$('build-destination-name').textContent=`${r.metadata.name} · Java ${r.metadata.version}`;resetPreview();controls();status('Destination opened for preview. Choose a placement corner.');}
    else if(r===null)status('Destination selection canceled.');
  };
  $('build-preview').onclick=async()=>{
    const r=await run(()=>(portable?api.previewBuildArchive:api.previewTransfer)({dimension:$('build-source-dimension').value,bounds:readBounds(),destinationDimension:$('build-destination-dimension').value,anchor:readAnchor(),airMode:$('placement-air-mode').value}),'Comparing source blocks, destination terrain and the boundary…');
    if(r){showAirEffects(r);$('placement-closed').checked=false;captured=r.source;preview=r;$('build-layer').value='differences';changeLayer();metrics([['PLACED INTO AIR',r.counts.placed],['OVERWRITTEN',r.counts.overwritten],['CARVED TO AIR',r.counts.carved],['AIR SKIPPED',r.counts.skippedAir],['UNKNOWN BLOCKS',r.counts.unknown],['BLOCKS CHANGED',r.effects.changedBlocks],['FLUID CHANGES',r.counts.fluid]]);findText([...r.blockers,...r.warnings,...r.source.issues,...r.destination.issues]);controls();status(r.copyEligible?'Placement preview complete. Review the changes, then create a separate test world copy.':'Placement preview complete. Neither world was changed. Copy placement is blocked; see the review notes.');}
  };
  $('build-save').onclick=async()=>{const r=await run(()=>api.saveTransferPlan(),'Saving an external preview report…');if(r)status(`Preview report saved outside both worlds: ${r.file}`);};
  for(const k of ['minX','minY','minZ','maxX','maxY','maxZ'])$(`build-${k}`).addEventListener('input',invalidateSource);
  $('build-source-dimension').onchange=async()=>{firstCorner=null;secondCorner=null;sourceView=null;captured=null;displayed=null;invalidateSource();heightOptions();applyHeight();await scanSource();};
  for(const k of ['x','y','z'])$(`build-anchor-${k}`).addEventListener('input',()=>{resetPreview();metrics(captured?[['NON-AIR BLOCKS',captured.stats.nonAir],['AIR BLOCKS',captured.stats.air],['UNKNOWN BLOCKS',captured.stats.unknown]]:[]);findText(['Placement changed. Run the comparison again before saving a report.']);});
  $('build-destination-dimension').onchange=()=>{destinationView=null;resetPreview();findText(['Destination dimension changed. Run the comparison again.']);};
  $('build-layer').onchange=changeLayer;$('build-view-mode').onchange=()=>{controls();updateSpectator();geometry=null;camera={zoom:1,x:0,y:0};render();};
  $('build-y').oninput=$('build-z').oninput=()=>{updateSpectator();geometry=null;render();};
  $('build-fit').onclick=()=>{spectator?.fit();camera={zoom:1,x:0,y:0};render();};
  api.onProgress(p=>{if(working&&progressCurrent())status(`${p.phase}${p.file?' · '+p.file:''}`);});



  function setStep(step,change=true){
    for(const name of ['source','destination']){ $(`${name}-pane`).hidden=name!==step;$(`step-${name}`).setAttribute('aria-selected',String(name===step)); }
    if(change&&step==='source'&&captured){$('build-layer').value='source';$('build-pick').value='inspect';changeLayer();}
    if(change&&step==='destination'&&destinationView){$('build-layer').value='destination';$('build-pick').value='place';changeLayer();}
  }
  $('step-source').onclick=()=>setStep('source');$('step-destination').onclick=$('next-placement').onclick=()=>setStep('destination');
  $('pick-corners').onclick=()=>{if($('build-layer').value!=='source'){$('build-layer').value='source';changeLayer();}$('build-pick').value='first';status('Click the first corner of the build, then its opposite corner. Use Camera & cutaway to reach buried blocks.');};
  function textureNote(message,error=false){$('texture-note').textContent=message;$('texture-note').classList.toggle('error',error);}
  async function loadPreviewTextures(force=false){
    if(!spectator||!displayed)return;
    const epoch=plannerEpoch,volume=displayed,key=volume.version+JSON.stringify(volume.palette);
    if(!$('use-textures').checked){++textureRequest;await spectator.setTextures(null);textureKey='';updateSpectator();textureNote('Block colors. Turn on textures for a more recognizable 3D preview.');return;}
    if(textureLoading)return;
    if(!force&&textureKey===key)return;
    const request=++textureRequest;textureLoading=true;controls();textureNote('Loading block textures…');
    try{
      const response=await api.loadTextures({palette:volume.palette,version:volume.version});if(response.error)throw new Error(response.error.message);const bundle=response.result;
      if(request!==textureRequest||epoch!==plannerEpoch||volume!==displayed)return;
      if(bundle.unavailable){await spectator.setTextures(null);updateSpectator();textureNote(bundle.message);return;}
      const atlas=await spectator.setTextures(bundle,volume.palette);if(request!==textureRequest||epoch!==plannerEpoch||volume!==displayed)return;textureKey=key;updateSpectator();
      const missing=volume.palette.filter(s=>s&&!air(s)).length-bundle.texturedStates;
      textureNote(`${atlas.count} texture${atlas.count===1?'':'s'} · ${bundle.label}${bundle.version&&bundle.version!==bundle.worldVersion?` (world ${bundle.worldVersion})`:''}${missing?` · ${missing} block states use colors`:''}. ${bundle.models?.filter(Boolean).length??0} modeled states; other shapes use cubes.${bundle.models?.some(m=>m?.weighted)?' Random variants use the first model.':''} Approximate biome colors.`,bundle.warnings.length>0||atlas.failures.length>0);
      $('texture-note').title=[...bundle.warnings,...atlas.failures].join('\n');
    }catch(e){if(request===textureRequest&&epoch===plannerEpoch&&volume===displayed){textureKey='';await spectator.setTextures(null);updateSpectator();textureNote(`Textures unavailable: ${e.message} Block colors remain usable.`,true);}}
    finally{if(epoch===plannerEpoch){textureLoading=false;controls();if(displayed&&volume!==displayed)loadPreviewTextures();}}
  }
  $('use-textures').onchange=()=>loadPreviewTextures(true);
  $('choose-textures').onclick=async()=>{const r=await run(()=>api.chooseTextures(),'Choose a Minecraft client JAR or a resource-pack ZIP…');if(r){textureKey='';await loadPreviewTextures(true);status('Texture source changed. World files remain unchanged.');}else if(r===null)status('Texture selection canceled.');};

  async function ensureSpectator(){
    if(spectator)return;
    try { const {Spectator}=await import('./spectator.js');spectator=new Spectator($('build-3d'),{color,onHover:p=>{$('build-hover').textContent=`Block ${p.x}, ${p.y}, ${p.z} · ${p.state?.Name??'UNKNOWN — not air'}${p.state?.Properties?' '+JSON.stringify(p.state.Properties):''}`;},onPick:pickBlock,onError:m=>status(m,true),onCamera:p=>{$('build-camera').textContent=`Camera ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;}}); }
    catch(e){$('build-view-mode').value='iso';status(`3D unavailable: ${e.message}. Slice and isometric previews remain available.`,true);}
  }
  function updateSpectator(){if(!spectator)return;spectator.setActive(dialog.open&&$('build-view-mode').value==='spectator');if(displayed){spectator.setVolume(displayed,overlay,Number($('build-y').value),Number($('build-z').value));updateSelection();}else spectator.clear();}
  function updateSelection(){
    if(!spectator)return;let b=readBounds();
    if($('build-layer').value!=='source'){const a=readAnchor();b={minX:a.x,minY:a.y,minZ:a.z,maxX:a.x+b.maxX-b.minX,maxY:a.y+b.maxY-b.minY,maxZ:a.z+b.maxZ-b.minZ};}
    spectator.setSelection(Object.values(b).every(Number.isFinite)&&b.maxX>=b.minX&&b.maxY>=b.minY&&b.maxZ>=b.minZ?b:null);
  }
  function pickBlock(p){
    if(working||textureLoading)return;const action=$('build-pick').value,layer=$('build-layer').value;
    if(action==='inspect'||portable&&layer==='source')return;
    if(!p.state){status('Unknown data cannot be used as a selection corner.',true);return;}
    if(action==='place'){
      if(layer!=='destination'){status('Show the destination before choosing its placement corner.');return;}
      for(const k of ['x','y','z'])$(`build-anchor-${k}`).value=p[k];preview=null;$('placement-closed').checked=false;controls();$('build-save').disabled=true;updateSelection();status(`Placement corner: ${p.x}, ${p.y}, ${p.z}. Run Preview placement to compare.`);return;
    }
    if(layer!=='source'){status('Show source blocks to select the build.');return;}
    if(action==='first'){firstCorner=p;secondCorner=null;$('build-pick').value='second';status('First corner set. Choose the opposite corner; use cutaways to reach underground blocks.');}
    else {secondCorner=p;if(!firstCorner){const b=readBounds();firstCorner={x:b.minX,y:b.minY,z:b.minZ};}status('Both corners set. Scan source blocks to review and save this exact box.');}
    const a=firstCorner,b=secondCorner??firstCorner;for(const k of ['X','Y','Z']){const axis=k.toLowerCase();$(`build-min${k}`).value=Math.min(a[axis],b[axis]);$(`build-max${k}`).value=Math.max(a[axis],b[axis]);}scanMatches=false;preview=null;controls();updateSelection();
  }
  $('camera-speed').onchange=()=>{if(spectator)spectator.speed=Number($('camera-speed').value);};
  $('build-near-camera').onclick=async()=>{
    if(working||textureLoading||!spectator)return;
    const layer=$('build-layer').value;if(!['source','destination'].includes(layer))return;
    const world=layer==='source'?sourceWorld:destinationWorld,dimension=$(layer==='source'?'build-source-dimension':'build-destination-dimension').value;
    const id=world?.dimensions.find(d=>d.key===dimension)?.id;
    if(!['minecraft:overworld','minecraft:the_nether','minecraft:the_end'].includes(id)){status('Camera neighborhood loading currently supports vanilla dimensions. Use exact bounds for custom dimensions.',true);return;}
    const pose=spectator.pose(),p=pose?.position;if(!p)return;
    const bottom=id==='minecraft:overworld'?-64:0,top=id==='minecraft:overworld'?319:255;
    const cy=Math.max(bottom,Math.min(top,Math.floor(p.y))),cx=Math.floor(p.x/16)*16,cz=Math.floor(p.z/16)*16;
    const bounds={minX:cx-16,maxX:cx+31,minZ:cz-16,maxZ:cz+31,minY:Math.max(bottom,cy-32),maxY:Math.min(top,cy+31)};
    const r=await run(()=>api[layer==='source'?'viewSource':'viewDestination']({dimension,bounds}),'Loading terrain around the camera…');
    if(!r)return;
    if(layer==='source')sourceView=r;else destinationView=r;
    // Browsing never replaces the captured selection or a saved comparison.
    displayed=r;overlay=null;setupView();spectator.restorePose(pose);controls();
    status(`Nearby terrain loaded. Selection unchanged. ${r.stats.unknown.toLocaleString()} unknown blocks; outside the outline is uninspected.`);
  };
  $('camera-go').onclick=()=>{const p=Object.fromEntries(['x','y','z'].map(k=>[k,Number($(`camera-${k}`).value)]));if(Object.values(p).every(n=>Number.isFinite(n)&&Math.abs(n)<=30000000))spectator?.jumpTo(p);else status('Enter finite camera coordinates within ±30,000,000.',true);};
  function heightOptions(){const id=sourceWorld?.dimensions.find(d=>d.key===$('build-source-dimension').value)?.id,nether=id==='minecraft:the_nether';for(const o of $('build-height').options)if(['roof','below'].includes(o.value))o.disabled=!nether;$('build-height').value='full';$('build-dimension-note').textContent=nether?'Nether includes the roof. Full height: Y 0–255. Roof preset starts at Y 128; include access tunnels separately.':'Each selection belongs to exactly one dimension. Portal networks need coordinated placement across dimensions.';}
  function applyHeight(){const mode=$('build-height').value,id=sourceWorld.dimensions.find(d=>d.key===$('build-source-dimension').value)?.id;if(mode==='custom')return;const [lo,hi]=mode==='roof'?[128,255]:mode==='below'?[0,127]:id==='minecraft:overworld'?[-64,319]:[0,255];$('build-minY').value=lo;$('build-maxY').value=hi;invalidateSource();}
  $('build-height').onchange=applyHeight;
  async function refreshLibrary(){const r=await run(()=>api.listSelections(),'Loading saved selections…');if(r){savedSelections=r;$('build-library').replaceChildren();const none=document.createElement('option');none.value='';none.textContent='Choose a saved selection';$('build-library').append(none);for(const s of r){const o=document.createElement('option');o.value=s.id;const dim=sourceWorld.dimensions.find(d=>d.key===s.dimension)?.id??s.dimension;o.textContent=`${s.name} · ${dim.replace('minecraft:','')}`;$('build-library').append(o);}controls();}}
  $('build-library').onchange=controls;
  $('build-selection-save').onclick=async()=>{if(!scanMatches)return;const r=await run(()=>api.saveSelection($('build-selection-name').value),'Saving selection boundaries outside the world…');if(r){await refreshLibrary();status(`Saved “${r.entry.name}”. This stores boundaries; reload reads current source blocks.`);}};
  $('build-selection-load').onclick=async()=>{const s=savedSelections.find(s=>s.id===$('build-library').value);if(!s)return;if(!sourceWorld.dimensions.some(d=>d.key===s.dimension)){status('The saved dimension is not present.',true);return;}$('build-source-dimension').value=s.dimension;heightOptions();$('build-height').value='custom';for(const [k,v]of Object.entries(s.bounds))$(`build-${k}`).value=v;$('build-selection-name').value=s.name;firstCorner=null;secondCorner=null;scanMatches=false;const result=await scanSource();if(result)status(result.digest===s.digest?'Saved selection reloaded; block content matches the saved scan.':'Saved selection reloaded. Block content changed since it was saved; review it again.',result.digest!==s.digest);};
  $('build-view-destination').onclick=async()=>{
    const a=readAnchor(),id=destinationWorld?.dimensions.find(d=>d.key===$('build-destination-dimension').value)?.id,minY=id==='minecraft:overworld'?-64:0,maxY=id==='minecraft:overworld'?319:255;
    const bounds={minX:Math.floor(a.x/16)*16,minZ:Math.floor(a.z/16)*16,minY:Math.max(minY,a.y-24),maxX:Math.floor(a.x/16)*16+15,maxZ:Math.floor(a.z/16)*16+15,maxY:Math.min(maxY,a.y+40)};
    const r=await run(()=>api.viewDestination({dimension:$('build-destination-dimension').value,bounds}),'Loading destination terrain near the placement coordinates…');if(r){destinationView=r;$('build-layer').value='destination';changeLayer();$('build-pick').value='place';status('Click a destination block for the minimum placement corner, then preview. Outside the outline is not loaded.');}
  };
  for(const b of document.querySelectorAll('.build-nudges button'))b.onclick=()=>{if(working)return;const input=$(`build-anchor-${b.dataset.axis}`);input.value=Number(input.value)+Number(b.dataset.step);preview=null;$('placement-closed').checked=false;controls();$('build-save').disabled=true;updateSelection();status('Moved the placement corner one block. Preview again to update the proposed blocks.');};

  function color(s) {
    if(!s)return '#cd90df';const n=s.Name;
    if(/nether_portal/.test(n))return '#aa6cdb';if(/obsidian/.test(n))return '#443650';if(/bedrock/.test(n))return '#606568';if(/netherrack/.test(n))return '#a06362';
    if(/water|ice/.test(n))return '#568ac6';if(/lava/.test(n))return '#e88642';
    if(/grass|moss|leaves|azalea|fern/.test(n))return '#7d9f64';if(/dirt|mud|farmland/.test(n))return '#967958';
    if(/sand|end_stone/.test(n))return '#c2b681';if(/snow|quartz|calcite/.test(n))return '#d4ddd2';
    if(/glass/.test(n))return '#a4d3d6';if(/deepslate|blackstone|coal/.test(n))return '#54656e';
    if(/stone|gravel|andesite|tuff/.test(n))return '#879696';if(/planks|log|wood|stairs|fence/.test(n))return '#b09a72';
    let hash=0;for(const c of n)hash=(hash*31+c.charCodeAt(0))|0;return `hsl(${Math.abs(hash)%360}, 24%, 58%)`;
  }
  function sample(x,y,z,cutY,cutZ) {
    const v=displayed;if(x<0||y<0||z<0||x>=v.size.x||y>=v.size.y||z>=v.size.z||y>cutY||z>cutZ)return null;
    const i=at(v,x,y,z),s=v.palette[v.voxels[i]],diff=overlay?.[i]??0;
    if(overlay&&diff)return {s,color:diffColors[diff],diff};
    if(air(s))return null;
    return {s,color:overlay?'#354b4b':color(s),diff};
  }
  function render(){if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);}
  function draw() {
    frame=0;const fly=$('build-view-mode').value==='spectator';$('build-3d').hidden=!fly;canvas.hidden=fly;if(fly){if(displayed){$('build-y-label').value=$('build-y').value;$('build-z-label').value=$('build-z').value;}return;}const w=canvas.clientWidth,h=canvas.clientHeight,ratio=window.devicePixelRatio||1;if(!w||!h)return;
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);plane=null;
    if(!displayed)return;
    const v=displayed,cutY=Number($('build-y').value)-v.bounds.minY,cutZ=Number($('build-z').value)-v.bounds.minZ;
    $('build-y-label').value=$('build-y').value;$('build-z-label').value=$('build-z').value;
    if($('build-view-mode').value!=='iso'){drawSlice(w,h,cutY,cutZ);return;}
    const key=`${cutY}:${cutZ}`;
    if(!geometry||geometryKey!==key){
      geometryKey=key;const faces=[];let limited=false;
      const project=(x,y,z)=>[x-z,(x+z)*.5-y];
      outer:for(let y=0;y<=Math.min(cutY,v.size.y-1);y++)for(let z=0;z<=Math.min(cutZ,v.size.z-1);z++)for(let x=0;x<v.size.x;x++){
        const cell=sample(x,y,z,cutY,cutZ);if(!cell)continue;
        const sides=[[[1,0,0],[[x+1,y,z],[x+1,y,z+1],[x+1,y+1,z+1],[x+1,y+1,z]],.62],[[0,0,1],[[x,y,z+1],[x+1,y,z+1],[x+1,y+1,z+1],[x,y+1,z+1]],.8],[[0,1,0],[[x,y+1,z],[x+1,y+1,z],[x+1,y+1,z+1],[x,y+1,z+1]],1]];
        for(const [[dx,dy,dz],corners,shade] of sides){if(sample(x+dx,y+dy,z+dz,cutY,cutZ))continue;faces.push({points:corners.map(p=>project(...p)),color:cell.color,shade,depth:x+z+y*2});}
        if(faces.length>120000){limited=true;break outer;}
      }
      faces.sort((a,b)=>a.depth-b.depth);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      for(const f of faces)for(const [x,y]of f.points){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      geometry={faces,minX,maxX,minY,maxY,limited};
    }
    if(!geometry.faces.length){ctx.fillStyle='#b5c9bf';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('This cutaway contains only known air.',w/2,h/2);return;}
    if(geometry.limited){ctx.fillStyle='#e8c39e';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('Too many visible faces. Reduce the selection or use an exact slice.',w/2,h/2);return;}
    const g=geometry,scale=Math.min((w-65)/Math.max(1,g.maxX-g.minX),(h-45)/Math.max(1,g.maxY-g.minY))*camera.zoom;
    const ox=w/2-(g.minX+g.maxX)*scale/2+camera.x,oy=h/2-(g.minY+g.maxY)*scale/2+camera.y;
    for(const f of g.faces){ctx.beginPath();f.points.forEach(([x,y],i)=>i?ctx.lineTo(ox+x*scale,oy+y*scale):ctx.moveTo(ox+x*scale,oy+y*scale));ctx.closePath();ctx.fillStyle=f.color;ctx.fill();if(f.shade<1){ctx.fillStyle=`rgba(0,0,0,${1-f.shade})`;ctx.fill();}if(scale>5){ctx.strokeStyle='#0e1b202b';ctx.lineWidth=.5;ctx.stroke();}}
  }
  function drawSlice(w,h,cutY,cutZ){
    const v=displayed,horizontal=$('build-view-mode').value==='horizontal',columns=v.size.x,rows=horizontal?v.size.z:v.size.y;
    const scale=Math.min((w-40)/columns,(h-35)/rows)*camera.zoom,ox=(w-columns*scale)/2+camera.x,oy=(h-rows*scale)/2+camera.y;
    plane={horizontal,scale,ox,oy,columns,rows,cutY,cutZ};
    for(let row=0;row<rows;row++)for(let x=0;x<columns;x++){
      const y=horizontal?cutY:rows-1-row,z=horizontal?row:cutZ,i=at(v,x,y,z),s=v.palette[v.voxels[i]],diff=overlay?.[i]??0;
      ctx.fillStyle=overlay&&diff?diffColors[diff]:!s?'#cd90df':air(s)?'#14262d':color(s);
      ctx.fillRect(ox+x*scale,oy+row*scale,Math.max(1,scale-.4),Math.max(1,scale-.4));
    }
  }
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,original:{...camera}};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{
    if(drag){camera.x=drag.original.x+e.clientX-drag.x;camera.y=drag.original.y+e.clientY-drag.y;render();return;}
    if(!plane||!displayed)return;
    const r=canvas.getBoundingClientRect(),p=plane,x=Math.floor((e.clientX-r.left-p.ox)/p.scale),row=Math.floor((e.clientY-r.top-p.oy)/p.scale);
    if(x<0||row<0||x>=p.columns||row>=p.rows)return;
    const y=p.horizontal?p.cutY:p.rows-1-row,z=p.horizontal?row:p.cutZ,s=displayed.palette[displayed.voxels[at(displayed,x,y,z)]];
    plane.hover={x:x+displayed.bounds.minX,y:y+displayed.bounds.minY,z:z+displayed.bounds.minZ,state:s};
    $('build-hover').textContent=`Block ${x+displayed.bounds.minX}, ${y+displayed.bounds.minY}, ${z+displayed.bounds.minZ} · ${s?s.Name+(s.Properties?' '+JSON.stringify(s.Properties):''):'UNKNOWN — not assumed to be air'}`;
  };
  canvas.onpointerup=e=>{if(drag&&Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y)<4&&plane?.hover)pickBlock(plane.hover);drag=null;};canvas.onpointercancel=()=>{drag=null;};canvas.addEventListener('wheel',e=>{e.preventDefault();camera.zoom=Math.max(.3,Math.min(12,camera.zoom*(e.deltaY<0?1.15:1/1.15)));render();},{passive:false});
  new ResizeObserver(render).observe(canvas);
})();
