import {makeAtlas, textureStateKey} from './textures.js';
import * as THREE from '../node_modules/three/build/three.module.js';
const air = s => ['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(s?.Name);
const faces = [
  [[1,0,0],[[1,0,0],[1,1,0],[1,1,1],[1,0,1]],.72],
  [[-1,0,0],[[0,0,1],[0,1,1],[0,1,0],[0,0,0]],.66],
  [[0,1,0],[[0,1,1],[1,1,1],[1,1,0],[0,1,0]],1],
  [[0,-1,0],[[0,0,0],[1,0,0],[1,0,1],[0,0,1]],.52],
  [[0,0,1],[[1,0,1],[1,1,1],[0,1,1],[0,0,1]],.84],
  [[0,0,-1],[[0,0,0],[0,1,0],[1,1,0],[1,0,0]],.78]
];
const cubeQuads=faces.map(([normal,points],direction)=>({points,direction,cull:direction,uvs:(direction===2||direction===3?[[0,1],[1,1],[1,0],[0,0]]:[[1,1],[1,0],[0,0],[0,1]])}));
export class Spectator {
  constructor(canvas, {color,onHover,onPick,onCamera,onError}) {
    this.canvas=canvas;this.options={color,onHover,onPick,onCamera,onError};this.volume=null;this.keys=new Set();this.active=false;this.speed=20;
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(65,1,.02,10000);this.camera.rotation.order='YXZ';
    this.ray=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.mesh=null;this.unknownMesh=null;
    this.selection=this.box(0x9de6bc);this.hover=this.box(0xffffff);this.loaded=this.box(0x4a676e);this.loaded.material.opacity=.45;this.loaded.material.transparent=true;
    canvas.tabIndex=0;canvas.oncontextmenu=e=>e.preventDefault();
    canvas.addEventListener('pointerdown',e=>{canvas.focus();this.drag={x:e.clientX,y:e.clientY,moved:false,button:e.button};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{
      if(this.drag?.button===2){const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;this.camera.rotation.y-=dx*.004;this.camera.rotation.x=Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,this.camera.rotation.x-dy*.004));this.drag={...this.drag,x:e.clientX,y:e.clientY,moved:true};}
      this.pick(e,false);
    });
    canvas.addEventListener('pointerup',e=>{if(this.drag?.button===0)this.pick(e,true);this.drag=null;});
    canvas.addEventListener('pointercancel',()=>this.drag=null);
    canvas.addEventListener('keydown',e=>{if(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)){e.preventDefault();this.keys.add(e.code);}});
    canvas.addEventListener('keyup',e=>this.keys.delete(e.code));canvas.addEventListener('blur',()=>{this.keys.clear();this.drag=null;});
    canvas.addEventListener('wheel',e=>{e.preventDefault();this.camera.translateZ(e.deltaY*.015);},{passive:false});
    this.resize=new ResizeObserver(()=>this.resizeView());this.resize.observe(canvas);
    let last=performance.now();const tick=now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(this.active){const step=this.speed*dt*(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')?4:1);this.camera.translateX((+this.keys.has('KeyD')-this.keys.has('KeyA'))*step);this.camera.translateZ((+this.keys.has('KeyS')-this.keys.has('KeyW'))*step);this.camera.position.y+=(+this.keys.has('KeyE')-this.keys.has('KeyQ'))*step;this.camera.rotation.y+=(+this.keys.has('ArrowLeft')-this.keys.has('ArrowRight'))*dt;this.camera.rotation.x=Math.max(-1.56,Math.min(1.56,this.camera.rotation.x+(+this.keys.has('ArrowUp')-this.keys.has('ArrowDown'))*dt));this.renderer.render(this.scene,this.camera);if(this.volume){const b=this.volume.bounds;this.options.onCamera({x:this.camera.position.x+b.minX,y:this.camera.position.y+b.minY,z:this.camera.position.z+b.minZ});}}requestAnimationFrame(tick);};requestAnimationFrame(tick);
  }
  box(color){const b=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1)),new THREE.LineBasicMaterial({color,depthTest:false}));b.visible=false;b.renderOrder=3;this.scene.add(b);return b;}
  resizeView(){const w=this.canvas.clientWidth,h=this.canvas.clientHeight;if(w&&h){this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}}
  setActive(active){this.active=active;if(!active)this.keys.clear();else this.resizeView();}
  setBox(box,bounds){if(!bounds||!this.volume){box.visible=false;return;}const b=this.volume.bounds;box.position.set((bounds.minX+bounds.maxX+1)/2-b.minX,(bounds.minY+bounds.maxY+1)/2-b.minY,(bounds.minZ+bounds.maxZ+1)/2-b.minZ);box.scale.set(bounds.maxX-bounds.minX+1.012,bounds.maxY-bounds.minY+1.012,bounds.maxZ-bounds.minZ+1.012);box.visible=true;}
  setSelection(bounds){this.setBox(this.selection,bounds);}
  async setTextures(bundle,palette){const atlas=bundle?await makeAtlas(bundle,palette):null;this.textures?.texture.dispose();this.textures=atlas;if(atlas)this.models=atlas.models;this.canvas.dataset.textureCount=String(atlas?.count??0);return atlas;}
  clear(){for(const key of ['mesh','unknownMesh','transparentMesh'])if(this[key]){this.scene.remove(this[key]);this[key].geometry.dispose();this[key].material.dispose();this[key]=null;}this.volume=null;this.loaded.visible=this.selection.visible=this.hover.visible=false;this.canvas.dataset.faceCount='0';}
  setVolume(v,overlay,cutY=v.bounds.maxY,cutZ=v.bounds.maxZ){
    const changed=this.volume!==v;this.volume=v;this.hover.visible=false;for(const key of ['mesh','unknownMesh','transparentMesh'])if(this[key]){this.scene.remove(this[key]);this[key].geometry.dispose();this[key].material.dispose();this[key]=null;}
    const positions=[],colors=[],uvs=[],owners=[],unknownPositions=[],unknownColors=[],unknownOwners=[],transparentPositions=[],transparentColors=[],transparentOwners=[],transparentUvs=[],focus={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity},color=new THREE.Color(),size=v.size;
    const atlas=!overlay?this.textures:null,faceStyles=v.palette.map(s=>atlas?.faces.get(textureStateKey(s))),models=v.palette.map(s=>!overlay?this.models?.get(textureStateKey(s)):null);
    this.canvas.dataset.modelCount=String(models.filter(Boolean).length);
    const cell=(x,y,z)=>{if(x<0||y<0||z<0||x>=size.x||y>=size.y||z>=size.z||y+v.bounds.minY>cutY||z+v.bounds.minZ>cutZ)return null;const i=y*size.x*size.z+z*size.x+x,s=v.palette[v.voxels[i]],diff=overlay?.[i]??0;return air(s)&&!diff?null:{i,s,diff};};
    let limited=false;
    outer:for(let y=0;y<size.y;y++)for(let z=0;z<size.z;z++)for(let x=0;x<size.x;x++){
      const c=cell(x,y,z);if(!c)continue;
      if(c.s&&!air(c.s)){focus.minX=Math.min(focus.minX,x);focus.maxX=Math.max(focus.maxX,x+1);focus.minY=Math.min(focus.minY,y);focus.maxY=Math.max(focus.maxY,y+1);focus.minZ=Math.min(focus.minZ,z);focus.maxZ=Math.max(focus.maxZ,z+1);}
      const model=models[v.voxels[c.i]],quads=model?.quads??cubeQuads;
      for(const q of quads){
        const fi=q.direction,normal=faces[q.cull]?.[0],neighbor=normal?cell(x+normal[0],y+normal[1],z+normal[2]):null;
        if(neighbor){
          const neighborModel=models[v.voxels[neighbor.i]];
          const opaque=neighborModel?.occludes??(!models[v.voxels[neighbor.i]]&&/^(minecraft:)?(stone|dirt|bedrock|netherrack|deepslate|.*_planks)$/.test(neighbor.s?.Name??''));
          if((!c.s&&!neighbor.s)||(neighbor.s&&(overlay||opaque)))continue;
        }
        if(owners.length+unknownOwners.length+transparentOwners.length>=180000){limited=true;break outer;}
        const style=atlas?(model?q.style:faceStyles[v.voxels[c.i]]?.[fi]):null,rect=style??atlas?.blank,shade=q.shade===false?1:faces[fi][2];
        color.set(style?(style.tint?(c.s.Name==='minecraft:water'?'#4785dc':'#91bd59'):'#ffffff'):overlay&&c.diff?['#526b69','#91dfa6','#efb164','#ef7f88','#da9aeb','#80b5ef','#b8a5ee'][c.diff]:overlay?'#354b4b':this.options.color(c.s));
        const translucent=c.s&&atlas&&q.translucent,pointsOut=!c.s?unknownPositions:translucent?transparentPositions:positions,colorsOut=!c.s?unknownColors:translucent?transparentColors:colors,uvOut=translucent?transparentUvs:uvs;
        for(const corner of [0,1,2,0,2,3]){
          const p=q.points[corner];if(c.s&&rect){const [u,t]=q.uvs[corner];uvOut.push(rect.u0+u*(rect.u1-rect.u0),rect.v1-t*(rect.v1-rect.v0));}
          pointsOut.push(x+p[0],y+p[1],z+p[2]);colorsOut.push(color.r*shade,color.g*shade,color.b*shade);
        }
        (!c.s?unknownOwners:translucent?transparentOwners:owners).push(c.i);
      }
    }
    this.canvas.dataset.faceCount=String(owners.length+unknownOwners.length+transparentOwners.length);
    if(limited){this.canvas.dataset.faceCount='0';this.options.onError('Too many visible faces. Reduce the selection or use a slice; the incomplete 3D mesh is hidden.');}
    else {for(const [key,p,c,o,uv]of [['mesh',positions,colors,owners,uvs],['transparentMesh',transparentPositions,transparentColors,transparentOwners,transparentUvs],['unknownMesh',unknownPositions,unknownColors,unknownOwners,[]]]){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(p,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(c,3));geometry.computeBoundingSphere();const unknown=key==='unknownMesh',translucent=key==='transparentMesh';if(!unknown&&atlas)geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));this[key]=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:!unknown&&atlas?atlas.texture:null,alphaTest:!unknown&&atlas ? 0.1 : 0,vertexColors:true,side:THREE.DoubleSide,transparent:unknown||translucent,opacity:unknown?.18:1,depthWrite:!unknown&&!translucent}));this[key].userData.owners=o;this.scene.add(this[key]);}}
    this.focusBounds=Number.isFinite(focus.minX)?focus:null;
    this.setBox(this.loaded,v.bounds);if(changed)this.fit();
  }
  fit(){if(!this.volume)return;const s=this.volume.size,b=this.focusBounds??{minX:0,minY:0,minZ:0,maxX:s.x,maxY:s.y,maxZ:s.z},cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2,cz=(b.minZ+b.maxZ)/2,extent=Math.max(b.maxX-b.minX,b.maxY-b.minY,b.maxZ-b.minZ,2);this.camera.position.set(cx+extent*.8,cy+extent*.6,cz+extent*.95);this.camera.lookAt(cx,cy,cz);this.resizeView();}
  pose(){return {position:this.position(),rotation:this.camera.quaternion.toArray()};}
  restorePose(pose){if(!pose?.position)return;this.jumpTo(pose.position);this.camera.quaternion.fromArray(pose.rotation);}
  position(){if(!this.volume)return null;const b=this.volume.bounds;return {x:this.camera.position.x+b.minX,y:this.camera.position.y+b.minY,z:this.camera.position.z+b.minZ};}
  jumpTo(p){if(!this.volume)return;const b=this.volume.bounds;this.camera.position.set(p.x-b.minX,p.y-b.minY,p.z-b.minZ);this.canvas.focus();}
  pick(event,commit){if(!this.mesh||!this.volume)return;const r=this.canvas.getBoundingClientRect();this.pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);this.camera.updateMatrixWorld();this.ray.setFromCamera(this.pointer,this.camera);const hits=this.ray.intersectObjects([this.mesh,this.transparentMesh,this.unknownMesh].filter(Boolean));const hit=hits.find(h=>h.object!==this.unknownMesh)??hits[0];if(!hit){this.hover.visible=false;return;}const i=hit.object.userData.owners[Math.floor(hit.faceIndex/2)],v=this.volume,x=i%v.size.x+v.bounds.minX,y=Math.floor(i/(v.size.x*v.size.z))+v.bounds.minY,z=Math.floor(i/v.size.x)%v.size.z+v.bounds.minZ;const p={x,y,z,state:v.palette[v.voxels[i]]};this.setBox(this.hover,{minX:x,maxX:x,minY:y,maxY:y,minZ:z,maxZ:z});this.options.onHover(p);if(commit)this.options.onPick(p);}
}
