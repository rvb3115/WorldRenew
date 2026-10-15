import * as THREE from '../node_modules/three/build/three.module.js';
import { topographicWindow, surfaceGeometry, pickedColumn, TOPO_CHUNK_LIMIT } from './topography-geometry.js';
const key=(x,z)=>`${x},${z}`;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export class TopographicMap {
  constructor(canvas,{onSelect,onHover,onNavigate,onFailure,canInteract,tool}) {
    Object.assign(this,{canvas,onSelect,onHover,onNavigate,onFailure,canInteract,tool});
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
    this.renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));this.renderer.setClearColor(0x101b1f);
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(45,1,.1,3000);this.ray=new THREE.Raycaster();
    this.entries=new Map();this.materials=new Map();this.queue=[];this.active=false;this.frame=null;
    this.x=0;this.z=0;this.y=64;this.distance=270;this.yaw=-.4;this.tilt=.83;this.origin={x:0,z:0};
    this.surfaceMaterial=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,toneMapped:false});
    this.bind();
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.unavailable=true;this.setActive(false);this.onFailure('Topographic graphics context was lost. Top-down remains available; reopen the app to retry 3D.');});
  }
  setActive(active){this.active=active;this.canvas.hidden=!active;if(!active){cancelAnimationFrame(this.frame);this.frame=null;this.gesture=null;}else this.requestFrame();}
  setLocation(x,z,span=160){this.x=clamp(x,-30000000,30000000);this.z=clamp(z,-30000000,30000000);this.distance=clamp(span*1.65,55,520);this.focusHeight=true;this.changed();}
  changed(){this.onNavigate(this.x,this.z);this.sync();this.requestFrame();}
  zoom(factor){if(!this.canInteract())return;this.distance=clamp(this.distance/factor,35,600);this.requestFrame();}
  north(){this.yaw=0;this.tilt=.83;this.requestFrame();}
  update(terrain,mark){
    this.terrain=terrain;this.mark=mark;
    if(this.generation!==terrain.generation){this.clear();this.generation=terrain.generation;this.focusHeight=true;this.y=terrain.dimension?.id==='minecraft:the_nether'?50:64;}
    this.sync();this.requestFrame();
  }
  sync(){
    if(!this.active||!this.terrain?.dimension)return;
    const cells=topographicWindow(this.x,this.z),wanted=new Set(cells.map(c=>key(c.x,c.z)));
    this.origin={x:Math.floor(this.x/16)*16,z:Math.floor(this.z/16)*16};
    this.terrain.requestWindow(cells);
    for(const [id,entry] of this.entries)if(!wanted.has(id)){this.disposeEntry(entry);this.entries.delete(id);}
    this.queue=[];
    for(const cell of cells){
      const id=key(cell.x,cell.z),tile=this.terrain.tileAt(cell.x,cell.z);
      const neighbors={west:this.terrain.tiles.get(key(cell.x-1,cell.z)),east:this.terrain.tiles.get(key(cell.x+1,cell.z)),north:this.terrain.tiles.get(key(cell.x,cell.z-1)),south:this.terrain.tiles.get(key(cell.x,cell.z+1))};
      const previous=this.entries.get(id),signature=[tile.status==='ready'?tile:tile.status,...Object.values(neighbors)];
      if(!previous||signature.some((item,i)=>previous.signature[i]!==item))this.queue.push({id,tile,neighbors,signature});
      if(previous){previous.group.position.set(cell.x*16-this.origin.x,0,cell.z*16-this.origin.z);this.style(previous);}
    }
    if(this.focusHeight){
      for(const cell of cells){const tile=this.terrain.tiles.get(key(cell.x,cell.z));if(tile?.status!=='ready')continue;
        const values=Array.from(tile.heights).filter((_,i)=>tile.ids[i]).sort((a,b)=>a-b);
        if(values.length){this.y=values[Math.floor(values.length/2)]+1;this.focusHeight=false;break;}}
    }
    this.canvas.dataset.windowChunks=String(cells.length);
  }
  statusMaterial(status){
    if(this.materials.has(status))return this.materials.get(status);
    const color={pending:'#526673',unreadable:'#d98b9e',unsupported:'#b28bc4',absent:'#233b43',empty:'#35515e'}[status]??'#d98b9e';
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#192830';ctx.fillRect(0,0,128,128);ctx.strokeStyle=color;ctx.lineWidth=2;
    if(status==='unreadable'||status==='unsupported'){for(let i=-128;i<128;i+=20){ctx.beginPath();ctx.moveTo(i,128);ctx.lineTo(i+128,0);ctx.stroke();}}
    ctx.fillStyle=color;ctx.font='bold 13px sans-serif';ctx.textAlign='center';ctx.fillText({pending:'PENDING',unreadable:'UNREADABLE',unsupported:'UNSUPPORTED',absent:'ABSENT',empty:'NO SURFACE'}[status]??'UNKNOWN',64,68);
    ctx.strokeRect(1,1,126,126);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false});this.materials.set(status,material);return material;
  }
  createEntry({tile,neighbors,signature}){
    const group=new THREE.Group();group.position.set(tile.x*16-this.origin.x,0,tile.z*16-this.origin.z);
    let mesh,grid,faces;
    if(tile.status==='ready'){
      const data=surfaceGeometry(tile,neighbors),geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));geometry.setAttribute('color',new THREE.BufferAttribute(data.colors,3));geometry.computeBoundingSphere();
      mesh=new THREE.Mesh(geometry,this.surfaceMaterial);faces=data.faceColumns;
      const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.BufferAttribute(data.grid,3));
      grid=new THREE.LineSegments(lineGeometry,new THREE.LineBasicMaterial({color:0x112831,transparent:true,opacity:.7}));
      group.add(mesh,grid);
    }
    // Markers are annotations at a common plane, never inferred elevations.
    // A subtle base also permits picking decoded empty columns without filling them.
    const marker=new THREE.Mesh(new THREE.PlaneGeometry(16,16),this.statusMaterial(tile.status==='ready'?'empty':tile.status));
    marker.rotation.x=-Math.PI/2;marker.position.set(8,tile.status==='ready'?-66:this.y-2,8);group.add(marker);
    marker.visible=tile.status!=='ready'||tile.ids.some(id=>id===0);
    marker.userData={tile,marker:true};if(mesh)mesh.userData={tile,faces};
    const border=new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(16,0,0),new THREE.Vector3(16,0,0),new THREE.Vector3(16,0,16),new THREE.Vector3(16,0,16),new THREE.Vector3(0,0,16),new THREE.Vector3(0,0,16),new THREE.Vector3(0,0,0)]),new THREE.LineBasicMaterial({color:0x526570}));
    border.position.y=tile.status==='ready'?-65.9:this.y-1.9;group.add(border);
    border.visible=tile.status!=='ready'||!tile.ids.some(id=>id!==0);
    const entry={group,mesh,grid,marker,border,tile,signature};this.scene.add(group);this.style(entry);return entry;
  }
  style(entry){
    const color=this.mark?.(entry.tile.x,entry.tile.z);
    for(const line of [entry.grid,entry.border].filter(Boolean)){line.material.color.set(color??(line===entry.grid?'#112831':'#526570'));line.material.opacity=color?1:.7;line.material.depthTest=!color;line.renderOrder=color?3:0;}
    if(entry.tile.status!=='ready'){entry.marker.position.y=this.y-2;entry.border.position.y=this.y-1.9;}
  }
  disposeEntry(entry){this.scene.remove(entry.group);entry.group.traverse(object=>{object.geometry?.dispose();if(object.isLineSegments)object.material.dispose();});}
  clear(){for(const entry of this.entries.values())this.disposeEntry(entry);this.entries.clear();this.queue=[];}
  requestFrame(){if(this.active&&this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;try{this.render();}catch(error){this.unavailable=true;this.setActive(false);this.onFailure(`Topographic rendering failed: ${error.message}. Top-down remains available.`);}});}
  render(){
    if(!this.active)return;
    // At most two chunks per frame. No continuous idle animation loop.
    for(let i=0;i<2&&this.queue.length;i++){const next=this.queue.shift(),old=this.entries.get(next.id);if(old)this.disposeEntry(old);this.entries.set(next.id,this.createEntry(next));}
    const width=this.canvas.clientWidth,height=this.canvas.clientHeight;if(!width||!height)return;
    const size=this.renderer.getSize(new THREE.Vector2());if(size.x!==width||size.y!==height)this.renderer.setSize(width,height,false);
    this.camera.aspect=width/height;this.camera.updateProjectionMatrix();
    const target=new THREE.Vector3(this.x-this.origin.x,this.y,this.z-this.origin.z),horizontal=this.distance*Math.sin(this.tilt);
    this.camera.position.set(target.x+horizontal*Math.sin(this.yaw),target.y+this.distance*Math.cos(this.tilt),target.z+horizontal*Math.cos(this.yaw));this.camera.lookAt(target);this.camera.updateMatrixWorld();
    this.renderer.render(this.scene,this.camera);
    const triangles=this.renderer.info.render.triangles;
    const counts={};for(const entry of this.entries.values())counts[entry.tile.status]=(counts[entry.tile.status]??0)+1;
    Object.assign(this.canvas.dataset,{meshes:String(this.entries.size),triangles:String(triangles),building:String(this.queue.length),yaw:String(this.yaw),centerX:String(this.x),centerZ:String(this.z),states:JSON.stringify(counts),draws:String((Number(this.canvas.dataset.draws)||0)+1)});
    document.getElementById('topographic-position').textContent=`Center X ${Math.round(this.x)} · Z ${Math.round(this.z)} · rotation ${Math.round(this.yaw*180/Math.PI)}° · ${this.entries.size}/${TOPO_CHUNK_LIMIT} tiles`;
    if(this.queue.length)this.requestFrame();
  }
  pick(clientX,clientY){
    const rect=this.canvas.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1),this.camera);
    const objects=[...this.entries.values()].flatMap(entry=>[entry.mesh,entry.marker].filter(object=>object?.visible));
    for(const hit of this.ray.intersectObjects(objects,false)){
      const {tile,faces,marker}=hit.object.userData;
      if(!marker)return pickedColumn(tile,faces,hit.faceIndex);
      const point=hit.object.parent.worldToLocal(hit.point.clone()),x=clamp(Math.floor(point.x),0,15),z=clamp(Math.floor(point.z),0,15);
      // A base under a known solid column is never a second selectable surface.
      if(tile.status==='ready'&&tile.ids[z*16+x])continue;
      return {x:tile.x,z:tile.z,blockX:tile.x*16+x,blockZ:tile.z*16+z};
    }
    return null;
  }
  bind(){
    const c=this.canvas;
    c.oncontextmenu=e=>e.preventDefault();
    c.onpointerdown=e=>{if(!this.canInteract()||![0,1,2].includes(e.button))return;c.focus();c.setPointerCapture(e.pointerId);
      const mode=e.shiftKey||e.button===1||this.tool()==='pan'?'pan':e.button===2||this.tool()==='orbit'?'orbit':'select';
      this.gesture={mode,startX:e.clientX,startY:e.clientY,x:this.x,z:this.z,yaw:this.yaw,tilt:this.tilt,start:this.pick(e.clientX,e.clientY)};};
    c.onpointermove=e=>{
      if(!this.canInteract())return;
      const g=this.gesture;if(g){const dx=e.clientX-g.startX,dy=e.clientY-g.startY;
        if(g.mode==='orbit'){this.yaw=g.yaw-dx*.008;this.tilt=clamp(g.tilt+dy*.006,.2,1.3);this.requestFrame();}
        if(g.mode==='pan'){const unit=this.distance*.0016;this.x=clamp(g.x+(-dx*Math.cos(this.yaw)-dy*Math.sin(this.yaw))*unit,-30000000,30000000);this.z=clamp(g.z+(dx*Math.sin(this.yaw)-dy*Math.cos(this.yaw))*unit,-30000000,30000000);this.changed();}}
      const picked=this.pick(e.clientX,e.clientY);this.onHover(picked);
    };
    c.onpointerup=e=>{const g=this.gesture;this.gesture=null;if(g?.mode==='select'&&this.canInteract()){const end=this.pick(e.clientX,e.clientY);if(g.start&&end)this.onSelect(g.start,end);}};
    c.onpointercancel=()=>{this.gesture=null;};
    c.addEventListener('wheel',e=>{if(!this.canInteract())return;e.preventDefault();this.zoom(e.deltaY<0?1.15:1/1.15);},{passive:false});
    c.onkeydown=e=>{if(!this.canInteract())return;const directions={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16]};
      if(directions[e.key]){e.preventDefault();const [x,z]=directions[e.key];this.x=clamp(this.x+x,-30000000,30000000);this.z=clamp(this.z+z,-30000000,30000000);this.changed();}
      if(e.key==='+'||e.key==='=')this.zoom(1.3);if(e.key==='-')this.zoom(1/1.3);
      if(e.key.toLowerCase()==='q'){this.yaw-=.2;this.requestFrame();}if(e.key.toLowerCase()==='e'){this.yaw+=.2;this.requestFrame();}};
  }
}
