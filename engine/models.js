// Resource-pack geometry only. No world data is changed by this adapter.
import { requireThat } from './errors.js';
export const directions = ['east','west','up','down','south','north'];
export const normals = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
export const cubeCorners = [
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], [[0,0,1],[0,1,1],[0,1,0],[0,0,0]],
  [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],
  [[1,0,1],[1,1,1],[0,1,1],[0,0,1]], [[0,0,0],[0,1,0],[1,1,0],[1,0,0]]
];
export function resource(ref,kind){
  requireThat(typeof ref==='string'&&/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(ref)&&!ref.split('/').includes('..'),'ASSET_REF','Invalid Minecraft asset reference.');
  const [ns,relative]=ref.includes(':')?ref.split(':'):['minecraft',ref];return `assets/${ns}/${kind}/${relative}`;
}
export function rotateBlock([a,b,c],x=0,y=0){
  for(let n=0;n<x/90;n++)[b,c]=[c,-b];
  for(let n=0;n<y/90;n++)[a,c]=[-c,a];return [a,b,c].map(n=>n===0?0:n);
}
function condition(when,props,depth=0){
  requireThat(depth<24&&when&&typeof when==='object'&&!Array.isArray(when),'ASSET_MODEL','Invalid multipart condition.');
  return Object.entries(when).every(([key,value])=>{
    if(key==='OR'||key==='AND'){
      requireThat(Array.isArray(value)&&value.length<=256,'ASSET_MODEL','Invalid multipart alternatives.');
      return key==='OR'?value.some(v=>condition(v,props,depth+1)):value.every(v=>condition(v,props,depth+1));
    }
    requireThat(typeof value==='string','ASSET_MODEL','Invalid block-state condition.');
    const neg=value.startsWith('!'),values=(neg?value.slice(1):value).split('|');return values.includes(props?.[key])!==neg;
  });
}
function readModel(archive,ref,seen=new Set()){
  requireThat(seen.size<24&&!seen.has(ref),'ASSET_MODEL','Cyclic or overly deep block model.');seen.add(ref);
  const m=archive.json(resource(ref,'models')+'.json');if(!m)return null;
  const p=m.parent&&!m.parent.startsWith('builtin/')?readModel(archive,m.parent,seen):null;
  return {...p,...m,textures:{...p?.textures,...m.textures},elements:m.elements??p?.elements};
}
function texture(model,ref){
  const seen=new Set();let translucent=false;
  while(ref){
    if(typeof ref==='object'){translucent ||= ref.force_translucent===true;ref=ref.sprite;}
    if(typeof ref!=='string'||!ref.startsWith('#'))break;
    requireThat(seen.size<24&&!seen.has(ref),'ASSET_MODEL','Cyclic texture reference.');seen.add(ref);ref=model.textures?.[ref.slice(1)];
  }
  return {texture:ref?resource(ref,'textures')+'.png':null,translucent};
}
// Minecraft's default face UV projection, expressed in model pixels (V downward).
function project([x,y,z],face){return [[16-z,16-y],[z,16-y],[x,z],[x,16-z],[x,16-y],[16-x,16-y]][face];}
function elementRotate(p,r){
  if(!r)return p;
  requireThat(['x','y','z'].includes(r.axis)&&[-45,-22.5,0,22.5,45].includes(r.angle)&&Array.isArray(r.origin)&&r.origin.length===3&&r.origin.every(n=>Number.isFinite(n)&&n>=-16&&n<=32),'ASSET_MODEL','Unsupported element rotation.');
  const axis=['x','y','z'].indexOf(r.axis),a=(axis+1)%3,b=(axis+2)%3,v=p.map((n,i)=>n-r.origin[i]),theta=r.angle*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),u=v[a],w=v[b];
  v[a]=u*c-w*s;v[b]=u*s+w*c;if(r.rescale){v[a]/=c;v[b]/=c;}return v.map((n,i)=>n+r.origin[i]);
}
export function resolveModel(archive,state){
  const def=archive.json(resource(state.Name,'blockstates')+'.json'),choices=[];
  if(def?.variants){const entry=Object.entries(def.variants).find(([key])=>key===''||key.split(',').every(pair=>{const[k,v]=pair.split('=');return state.Properties?.[k]===v;}));if(entry)choices.push(entry[1]);}
  if(def?.multipart){requireThat(Array.isArray(def.multipart)&&def.multipart.length<=256,'ASSET_MODEL','Too many multipart pieces.');for(const part of def.multipart)if(!part.when||condition(part.when,state.Properties))choices.push(part.apply);}
  const quads=[];let weighted=false,parts=0;
  for(const alternative of choices){
    if(Array.isArray(alternative))weighted ||= alternative.length>1;
    const choice=Array.isArray(alternative)?alternative[0]:alternative;
    if(!choice?.model)continue;
    const model=readModel(archive,choice.model);requireThat(model?.elements?.length,'ASSET_MODEL','Missing or unsupported model geometry.');
    const rx=choice.x??0,ry=choice.y??0;
    requireThat([rx,ry].every(n=>[0,90,180,270].includes(n))&&Array.isArray(model.elements)&&model.elements.length<=256,'ASSET_MODEL','Unsupported model rotation or element count.');
    parts++;
    for(const e of model.elements){
      requireThat([e.from,e.to].every(p=>Array.isArray(p)&&p.length===3&&p.every(n=>Number.isFinite(n)&&n>=-16&&n<=32))&&e.from.every((n,i)=>n<=e.to[i]),'ASSET_MODEL','Invalid model element bounds.');
      for(const [name,f] of Object.entries(e.faces??{})){
        const fi=directions.indexOf(name);if(fi<0)continue;
        requireThat(quads.length<1536,'ASSET_MODEL','Block model has too many faces.');
        const rotation=f.rotation??0;requireThat([0,90,180,270].includes(rotation),'ASSET_MODEL','Invalid face UV rotation.');
        const corners=cubeCorners[fi].map(p=>p.map((n,i)=>n?e.to[i]:e.from[i]));
        const projected=corners.map(p=>project(p,fi)),us=projected.map(p=>p[0]),vs=projected.map(p=>p[1]);
        const uv=f.uv??[Math.min(...us),Math.min(...vs),Math.max(...us),Math.max(...vs)];
        requireThat(Array.isArray(uv)&&uv.length===4&&uv.every(n=>Number.isFinite(n)&&n>=0&&n<=16),'ASSET_MODEL','UVs outside one texture tile are not supported.');
        const normal=rotateBlock(normals[fi],rx,ry),direction=normals.findIndex(v=>v.every((n,i)=>n===normal[i]));
        const points=corners.map(p=>rotateBlock(elementRotate(p,e.rotation).map(n=>n-8),rx,ry).map(n=>(n+8)/16));
        let uvs=cubeCorners[fi].map(p=>project(p.map(n=>n*16),fi).map(n=>n/16));
        if(choice.uvlock)uvs=cubeCorners[fi].map(p=>project(rotateBlock(p.map(n=>n*16-8),rx,ry).map(n=>n+8),direction).map(n=>n/16));
        // Rotate the UV assignment around the face, independently of geometry.
        const original=uvs;uvs=uvs.map((_,i)=>original[(i+rotation/90)%4]).map(([u,v])=>[(uv[0]+u*(uv[2]-uv[0]))/16,(uv[1]+v*(uv[3]-uv[1]))/16]);
        const boundary=normals.findIndex((n,i)=>points.every(p=>Math.abs(p[Math.floor(i/2)]-(i%2?0:1))<1e-6));
        quads.push({...texture(model,f.texture),points,uvs,tint:f.tintindex!==undefined,direction,cull:boundary,shade:e.shade!==false});
      }
    }
  }
  if(!parts||!quads.length)return null;
  // Conservative occlusion: only a single complete, opaque cube hides neighbors.
  const transparent=/glass|leaves|ice|water|lava|slime|honey|portal/.test(state.Name)||quads.some(q=>q.translucent);
  const fullCube=quads.length===6&&normals.every((_,i)=>quads.some(q=>q.cull===i&&q.points.every(p=>p.every(n=>Math.abs(n)<1e-6||Math.abs(n-1)<1e-6))));
  return {quads,occludes:fullCube&&!transparent,weighted};
}
