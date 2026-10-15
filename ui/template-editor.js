(() => {
  const $=id=>document.getElementById(id),api=window.worldrenew,dialog=$('template-editor'),canvas=$('template-slice'),ctx=canvas.getContext('2d');
  const axes=['minX','minY','minZ','maxX','maxY','maxZ'],key=(x,z)=>`${x},${z}`,air=s=>s&&['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(s.Name);
  let world,dimension,draft,session,archive=null,destination=null,review=null,readOnly=false,working=false,loading=false,generation=0,firstCorner=null,gesture=null;
  let view={x:-32,z:-32,span:64,y:64},tiles=new Map(),loadError='',viewPositions=new Map();
  const number=n=>BigInt(n??0).toLocaleString();
  function status(message,error=false){$('template-editor-status').textContent=message;$('template-editor-status').classList.toggle('error',error);}
  function controls(){
    window.templateBusy=working;
    for(const input of dialog.querySelectorAll('button,input,select'))input.disabled=working;
    $('template-cancel').hidden=!working;$('template-cancel').disabled=!working;
    $('template-save').disabled=working||readOnly||!draft||draft.selectedBlocks==='0';
    $('template-export').disabled=working||!archive;
    $('template-current-destination').disabled=$('template-choose-destination').disabled=working||!archive;
    $('template-review').disabled=working||!archive||!destination||!api.previewStreamingTemplate;
    $('template-place').disabled=working||!review?.copyEligible||!$('template-placement-closed').checked;
    if(readOnly){$('template-tool').value='inspect';for(const o of $('template-tool').options)o.disabled=!['inspect','pan'].includes(o.value);}
    else for(const o of $('template-tool').options)o.disabled=false;
  }
  async function run(action,message){
    if(working)return;working=true;controls();status(message);
    try{const response=await action();if(response.error)throw new Error(response.error.message);return response.result;}
    catch(error){status(error.message,true);return undefined;}
    finally{working=false;controls();if(dialog.open)loadTiles();}
  }
  function summary(){
    const source=readOnly?archive?.summary:draft;
    $('template-selection-summary').textContent=source?`${number(source.selectedBlocks)} selected cells${readOnly?` · ${number(source.air)} selected air · ${source.chunks.toLocaleString()} chunks`:` · ${draft.boxes.toLocaleString()} selection boxes`}. Offscreen pieces are retained.`:'No blocks selected.';
    $('template-selection-summary').dataset.blocks=source?.selectedBlocks??'0';
    $('template-saved').textContent=archive?`Saved independently of the source: ${archive.file}`:readOnly?'':'Draft saved on this device. Save a template to freeze the blocks and air.';
    controls();
  }
  function setBounds(b){for(const axis of axes)$("template-"+axis).value=b[axis];}
  function bounds(){return Object.fromEntries(axes.map(axis=>[axis,Number($("template-"+axis).value)]));}
  function fillDimensions(select,dimensions,selected){select.replaceChildren();for(const d of dimensions){const option=document.createElement('option');option.value=d.key;option.textContent=d.id.replace('minecraft:','').replaceAll('_',' ');select.append(option);}select.value=selected??dimensions[0]?.key??'';}
  function updateViewControls(){
    $('template-center-x').value=Math.floor(view.x+view.span/2);$('template-center-z').value=Math.floor(view.z+view.span/2);$('template-slice-y').value=$('template-y-range').value=view.y;
  }
  function heightRange(min,max){for(const id of ['template-slice-y','template-y-range']){$(id).min=min;$(id).max=max;}view.y=Math.max(min,Math.min(max,Math.round(view.y)));}
  function redrawFromSource(){view.x=Math.max(-30000000,Math.min(30000000-view.span,view.x));view.z=Math.max(-30000000,Math.min(30000000-view.span,view.z));generation++;tiles=new Map();loadError='';updateViewControls();draw();loadTiles();}
  function centerAt(x,z){view.x=Math.round(x-view.span/2);view.z=Math.round(z-view.span/2);redrawFromSource();}
  function chosenBounds(){return readOnly?archive?.header.source.bounds:draft?.bounds;}
  function centerSelection(){const b=chosenBounds();if(b){view.y=Math.max(Number($('template-slice-y').min),Math.min(Number($('template-slice-y').max),b.minY));centerAt((b.minX+b.maxX+1)/2,(b.minZ+b.maxZ+1)/2);}}
  async function loadWorkspace(area){
    generation++;tiles=new Map();loadError='';draft=null;
    const result=await run(()=>api.templateWorkspace(dimension),'Loading the saved selection…');if(!result)return false;
    draft=result;session=result.session;heightRange(result.height?.minY??0,result.height?.maxY??255);
    const b=draft.bounds??{minX:world.metadata.spawn?.x??0,maxX:(world.metadata.spawn?.x??0)+15,minZ:world.metadata.spawn?.z??0,maxZ:(world.metadata.spawn?.z??0)+15,minY:Math.max(result.height?.minY??0,Math.min(64,result.height?.maxY??255)),maxY:Math.max(result.height?.minY??0,Math.min(79,result.height?.maxY??255)),...area};
    setBounds(b);view.y=b.minY;centerAt((b.minX+b.maxX+1)/2,(b.minZ+b.maxZ+1)/2);summary();status(result.metadataChanged?'World metadata changed since this draft. Review the selection; capture will read current blocks.':'Choose inclusive corners and height, then Replace selection. Edits are saved automatically.');return true;
  }
  window.openTemplateEditor=async({world:source,dimension:key,area})=>{
    if(!source||!key)return;world=source;dimension=key;draft=null;archive=null;destination=null;review=null;readOnly=false;firstCorner=null;viewPositions.clear();
    $('template-edit-controls').hidden=false;$('template-editor-title').textContent='Create a template';$('template-source-label').textContent=`${world.metadata.name} · Java ${world.metadata.version} · actual blocks at the chosen Y`;
    fillDimensions($('template-dimension'),world.dimensions,dimension);$('template-placement-result').textContent='';$('template-review-summary').textContent=api.previewStreamingTemplate?'':'Streaming placement is not available in this build. Capture, export and saved previews are available.';$('template-findings').replaceChildren();$('template-placement').open=false;$('template-destination-label').textContent='Save a template before choosing a destination.';
    dialog.showModal();controls();await loadWorkspace(area);
  };
  window.openStreamingTemplate=async value=>{
    archive=value;readOnly=true;world=null;dimension=value.header.source.dimensionKey;draft=null;destination=null;review=null;firstCorner=null;
    $('template-edit-controls').hidden=true;$('template-editor-title').textContent=value.name||value.id;$('template-source-label').textContent=`Saved template · ${value.header.source.version} · source world is not required`;
    $('template-placement-result').textContent='';$('template-review-summary').textContent=api.previewStreamingTemplate?'':'Streaming placement is not available in this build. Capture, export and saved previews are available.';$('template-findings').replaceChildren();$('template-placement').open=true;$('template-destination-label').textContent='Choose the destination copy to review.';
    heightRange(value.header.source.bounds.minY,value.header.source.bounds.maxY);view.span=64;dialog.showModal();summary();centerSelection();status('Template validated. Blue cells are selected; excluded cells never change the destination.');
  };
  function visibleChunks(){const result=[];for(let z=Math.floor(view.z/16);z<=Math.floor((view.z+view.span-1)/16);z++)for(let x=Math.floor(view.x/16);x<=Math.floor((view.x+view.span-1)/16);x++)result.push({x,z});return result;}
  async function loadTiles(){
    if(loading||working||!dialog.open||loadError||(!readOnly&&!draft))return;
    const token=generation;loading=true;
    try{
      while(dialog.open&&!working&&token===generation){
        const missing=visibleChunks().filter(c=>!tiles.has(key(c.x,c.z))).slice(0,16);if(!missing.length)break;
        const response=await api.templateSlice({source:readOnly?'template':'world',digest:archive?.digest,session,dimension,y:view.y,chunks:missing});
        if(token!==generation||!dialog.open)return;
        if(response.error?.code==='TEMPLATE_BUSY'){await new Promise(r=>setTimeout(r,120));continue;}
        if(response.error)throw new Error(response.error.message);
        if(!readOnly&&response.result.revision!==draft.revision){loadError='Selection changed. Close and reopen this editor to reload it.';break;}
        for(const tile of response.result.tiles)tiles.set(key(tile.x,tile.z),tile);draw();
      }
    }catch(error){if(token===generation){loadError=error.message;status(error.message,true);draw();}}
    finally{loading=false;if(token!==generation&&dialog.open)loadTiles();}
  }
  function geometry(){const width=canvas.clientWidth,height=canvas.clientHeight,size=Math.max(1,Math.min(width-42,height-28));return {width,height,size,left:(width-size)/2,top:20,cell:size/view.span};}
  function pick(event){const rect=canvas.getBoundingClientRect(),g=geometry(),x=Math.floor((event.clientX-rect.left-g.left)/g.cell)+view.x,z=Math.floor((event.clientY-rect.top-g.top)/g.cell)+view.z;if(x<view.x||x>=view.x+view.span||z<view.z||z>=view.z+view.span)return null;const tile=tiles.get(key(Math.floor(x/16),Math.floor(z/16))),i=((z%16+16)%16)*16+((x%16+16)%16);return {x,y:view.y,z,tile,index:i};}
  function draw(){
    if(!dialog.open)return;const g=geometry(),ratio=window.devicePixelRatio||1;canvas.width=Math.round(g.width*ratio);canvas.height=Math.round(g.height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle='#0b171b';ctx.fillRect(0,0,g.width,g.height);
    let known=0,selectedVisible=0;
    for(let z=0;z<view.span;z++)for(let x=0;x<view.span;x++){
      const bx=view.x+x,bz=view.z+z,tile=tiles.get(key(Math.floor(bx/16),Math.floor(bz/16))),i=((bz%16+16)%16)*16+((bx%16+16)%16),sx=g.left+x*g.cell,sz=g.top+z*g.cell,state=tile?.status==='ready'?tile.palette[tile.ids[i]]:null,selected=Boolean(tile?.selected[i]);
      let color='#43535c';if(tile){if(tile.status==='ready'){known++;color=air(state)?'#153943':`rgb(${tile.rgba[i*4]},${tile.rgba[i*4+1]},${tile.rgba[i*4+2]})`;if(readOnly&&!selected)color='#152529';}else color={absent:'#1d2c30',excluded:'#152529',unreadable:'#8a485e',unsupported:'#695577'}[tile.status]??'#8a485e';}
      ctx.fillStyle=color;ctx.fillRect(sx,sz,g.cell+.2,g.cell+.2);
      if(state&&air(state)&&(!readOnly||selected)){ctx.fillStyle=((bx+bz)&1)?'#3e6571':'#284e59';ctx.fillRect(sx,sz,g.cell,g.cell);}
      if(selected){selectedVisible++;ctx.fillStyle='#7bc8ff44';ctx.fillRect(sx,sz,g.cell,g.cell);ctx.strokeStyle='#8ed2ff';ctx.lineWidth=1;ctx.strokeRect(sx+.5,sz+.5,Math.max(0,g.cell-1),Math.max(0,g.cell-1));}
      if(g.cell>=9){ctx.strokeStyle='#07131966';ctx.lineWidth=.5;ctx.strokeRect(sx,sz,g.cell,g.cell);}
      if(tile?.status==='unreadable'&&g.cell>=12){ctx.fillStyle='#ffe6eb';ctx.font='11px sans-serif';ctx.fillText('!',sx+g.cell/2-2,sz+g.cell/2+4);}
    }
    ctx.strokeStyle='#92a9ac77';ctx.lineWidth=1;ctx.font='10px ui-monospace,monospace';ctx.fillStyle='#b6cbd0';
    for(let x=Math.ceil(view.x/16)*16;x<view.x+view.span;x+=16){const sx=g.left+(x-view.x)*g.cell;ctx.beginPath();ctx.moveTo(sx,g.top);ctx.lineTo(sx,g.top+g.size);ctx.stroke();ctx.fillText('X '+x,sx+3,12);}
    for(let z=Math.ceil(view.z/16)*16;z<view.z+view.span;z+=16){const sz=g.top+(z-view.z)*g.cell;ctx.beginPath();ctx.moveTo(g.left,sz);ctx.lineTo(g.left+g.size,sz);ctx.stroke();ctx.fillText('Z '+z,2,sz+10);}
    Object.assign(canvas.dataset,{minX:view.x,minZ:view.z,span:view.span,y:view.y,ready:known,selectedVisible,unreadable:[...tiles.values()].filter(t=>t.status==='unreadable').length,absent:[...tiles.values()].filter(t=>t.status==='absent').length,tiles:tiles.size,pending:visibleChunks().filter(c=>!tiles.has(key(c.x,c.z))).length,error:loadError});
    $('template-window-note').textContent=`${view.span} × ${view.span} blocks at Y ${view.y} · ${selectedVisible.toLocaleString()} selected cells in this slice window. ${loadError||'Gray: pending. Dark: absent/excluded. Pink: unreadable. Purple: unsupported. Checkered: known air.'}`;
  }
  async function edit(operation,input=bounds()){
    if(readOnly||!draft)return;const result=await run(()=>api.editTemplateSelection({session,dimension,revision:draft.revision,operation,bounds:input}),'Saving selection edit…');if(!result)return;
    draft=result;archive=null;review=null;summary();redrawFromSource();status(`${number(draft.selectedBlocks)} cells selected. Selection saved on this device.`);
  }
  for(const operation of ['replace','add','remove','clear'])$('template-'+operation).onclick=()=>edit(operation);
  $('template-dimension').onchange=async()=>{viewPositions.set(dimension,{...view});dimension=$('template-dimension').value;firstCorner=null;archive=null;review=null;await loadWorkspace();if(viewPositions.has(dimension)){view={...viewPositions.get(dimension)};redrawFromSource();}};
  $('template-save').onclick=async()=>{const result=await run(()=>api.captureTemplate({session,dimension,revision:draft.revision,name:$('template-name').value}),'Capturing selected blocks and exact supporting records…');if(result){archive=result;review=null;summary();status(`Saved ${number(result.summary.selectedBlocks)} cells in ${result.summary.chunks.toLocaleString()} chunks. The template no longer needs the source world.`);}};
  $('template-export').onclick=async()=>{const result=await run(()=>api.exportTemplate(null),'Choose a new location for the portable file…');if(result)status(`Exported ${result.file}. Import this .wrbuild on Windows or Mac.`);};
  $('template-cancel').onclick=()=>{api.cancelTemplate();status('Cancellation requested; the current bounded operation will finish safely.');};
  $('template-close').onclick=()=>dialog.close();dialog.addEventListener('cancel',event=>{if(working)event.preventDefault();});dialog.addEventListener('close',()=>{generation++;firstCorner=null;window.templateBusy=false;});
  function zoom(factor){const cx=view.x+view.span/2,cz=view.z+view.span/2;view.span=Math.max(8,Math.min(64,Math.round(view.span/factor)));centerAt(cx,cz);}
  $('template-zoom-in').onclick=()=>zoom(2);$('template-zoom-out').onclick=()=>zoom(.5);$('template-center-selection').onclick=centerSelection;
  $('template-go').onclick=()=>{const x=Number($('template-center-x').value),z=Number($('template-center-z').value);if(!Number.isInteger(x)||!Number.isInteger(z)||Math.abs(x)>29999968||Math.abs(z)>29999968){status('Enter whole center coordinates inside the world border.',true);return;}centerAt(x,z);};
  function height(value){const y=Number(value);if(!Number.isInteger(y)||y<Number($('template-slice-y').min)||y>Number($('template-slice-y').max)){status('Choose a whole Y inside the displayed range.',true);return;}view.y=y;redrawFromSource();}
  $('template-slice-y').onchange=()=>height($('template-slice-y').value);$('template-y-range').oninput=()=>height($('template-y-range').value);
  canvas.oncontextmenu=e=>e.preventDefault();canvas.onpointerdown=e=>{if(working||![0,1,2].includes(e.button))return;const point=pick(e);if(!point)return;canvas.focus();canvas.setPointerCapture(e.pointerId);gesture={point,x:e.clientX,z:e.clientY,startX:view.x,startZ:view.z,tool:e.button!==0||e.shiftKey?'pan':$('template-tool').value};};
  canvas.onpointermove=e=>{
    const p=pick(e);if(p){const state=p.tile?.status==='ready'?p.tile.palette[p.tile.ids[p.index]]:null,selected=Boolean(p.tile?.selected[p.index]);$('template-hover').textContent=`X ${p.x} · Y ${p.y} · Z ${p.z} · ${readOnly&&!selected?'Excluded: destination unchanged':state?state.Name+(state.Properties?' '+JSON.stringify(state.Properties):''):p.tile?.message??p.tile?.status??'pending'} · ${selected?'selected':'not selected'}`;}
    if(gesture?.tool==='pan'){const g=geometry();view.x=gesture.startX-Math.round((e.clientX-gesture.x)/g.cell);view.z=gesture.startZ-Math.round((e.clientY-gesture.z)/g.cell);draw();}
  };
  canvas.onpointerup=e=>{
    const g=gesture;gesture=null;if(!g||working)return;if(g.tool==='pan'){redrawFromSource();return;}const p=pick(e);if(!p||readOnly)return;
    if(['corners','add'].includes(g.tool)&&(p.tile?.status!=='ready'||g.point.tile?.status!=='ready')){status('Wait for known blocks before picking. Unreadable terrain cannot be inferred.',true);return;}
    if(g.tool==='corners'){
      if(!firstCorner){firstCorner={x:p.x,y:p.y,z:p.z};status('First corner set. Choose another Y if needed, then pick the opposite corner.');}
      else{const b=cornerBounds(firstCorner,p);setBounds(b);firstCorner=null;edit('replace',b);}
    }else if(['add','remove'].includes(g.tool)){const b=cornerBounds(g.point,p);setBounds(b);edit(g.tool,b);}
  };
  function cornerBounds(a,b){return {minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),minY:Math.min(a.y,b.y),maxY:Math.max(a.y,b.y),minZ:Math.min(a.z,b.z),maxZ:Math.max(a.z,b.z)};}
  canvas.onpointercancel=()=>{gesture=null;};canvas.addEventListener('wheel',e=>{if(working)return;e.preventDefault();zoom(e.deltaY<0?2:.5);},{passive:false});
  canvas.onkeydown=e=>{if(working)return;const step=Math.max(1,Math.floor(view.span/4)),d={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];if(d){e.preventDefault();view.x+=d[0];view.z+=d[1];redrawFromSource();}else if(['+','='].includes(e.key))zoom(2);else if(e.key==='-')zoom(.5);};
  new ResizeObserver(()=>draw()).observe(canvas);
  function anchor(){return {x:Number($('template-anchor-x').value),y:Number($('template-anchor-y').value),z:Number($('template-anchor-z').value)};}
  function invalidateReview(){review=null;$('template-placement-closed').checked=false;$('template-review-summary').textContent='Run a fresh placement preview after changes.';controls();}
  async function chooseDestination(current){const result=await run(()=>current?api.useCurrentTemplateDestination():api.openDestination(),'Opening the destination for review…');if(result){destination=result;fillDimensions($('template-destination-dimension'),result.dimensions,result.dimensions.find(d=>d.id===archive.header.source.dimensionId)?.key);$('template-destination-label').textContent=`${result.metadata.name} · Java ${result.metadata.version}`;invalidateReview();status('Destination selected. Set its anchor and air policy before previewing.');}}
  $('template-current-destination').onclick=()=>chooseDestination(true);$('template-choose-destination').onclick=()=>chooseDestination(false);
  for(const id of ['template-anchor-x','template-anchor-y','template-anchor-z','template-air','template-destination-dimension'])$(id).onchange=invalidateReview;
  $('template-placement-closed').onchange=controls;
  $('template-review').onclick=async()=>{if(!api.previewStreamingTemplate)return;const r=await run(()=>api.previewStreamingTemplate({digest:archive.digest,dimension:$('template-destination-dimension').value,anchor:anchor(),airMode:$('template-air').value}),'Reviewing the selected cells against the destination…');if(r){review=r;$('template-review-summary').textContent=r.copyEligible?'Placement is eligible. Review the changes before creating a separate copy.':'Placement is blocked. Your template remains saved.';$('template-findings').replaceChildren();for(const line of [...(r.blockers??[]),...(r.warnings??[])]){const li=document.createElement('li');li.textContent=line;$('template-findings').append(li);}controls();}};
  $('template-place').onclick=async()=>{if(!review?.copyEligible||!api.placeStreamingTemplate)return;const r=await run(()=>api.placeStreamingTemplate({reviewDigest:review.reviewDigest,confirmedClosed:$('template-placement-closed').checked}),'Creating a verified backup and separate test world…');if(r){$('template-placement-result').textContent=`Created ${r.world}. Original world files remain unchanged.`;invalidateReview();status('Separate test world created and verified. Test that copy in Minecraft.');}};
  api.onProgress(p=>{if(working)status(`${p.phase}${p.selectedBlocks?` · ${number(p.selectedBlocks)} selected cells`:''}${p.chunks?` · ${p.chunks} chunks`:''}${p.bytes?` · ${number(p.bytes)} bytes`:''}`);});
})();
