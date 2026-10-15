import * as THREE from '../node_modules/three/build/three.module.js';
export const textureStateKey = s => s ? s.Name+JSON.stringify(Object.entries(s.Properties??{}).sort(([a],[b])=>a.localeCompare(b))) : '';
/** Texture images stay in memory; no Minecraft assets are shipped with the app. */
export async function makeAtlas(bundle,palette){
  const entries=Object.entries(bundle.images),tile=64,pad=2,stride=tile+pad*2,columns=Math.ceil(Math.sqrt(entries.length+1)),canvas=document.createElement('canvas');
  canvas.width=canvas.height=columns*stride;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,stride,stride);const slots=new Map(),failures=[];
  for(let i=0;i<entries.length;i++){
    const [name,data]=entries[i],image=new Image();
    try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Texture image could not be decoded.'));image.src=data.url;});}
    catch{failures.push(name);continue;}
    const col=(i+1)%columns,row=Math.floor((i+1)/columns),x=col*stride+pad,y=row*stride+pad;
    // First square frame; retain alpha for cutout pixels in glass and foliage.
    ctx.drawImage(image,0,0,data.width,data.width,x,y,tile,tile);
    ctx.drawImage(canvas,x,y,1,tile,x-pad,y,pad,tile);ctx.drawImage(canvas,x+tile-1,y,1,tile,x+tile,y,pad,tile);
    ctx.drawImage(canvas,x-pad,y,stride,1,x-pad,y-pad,stride,pad);ctx.drawImage(canvas,x-pad,y+tile-1,stride,1,x-pad,y+tile,stride,pad);
    const pixels=ctx.getImageData(x,y,tile,tile).data;let hasAlpha=false,partialAlpha=false;for(let a=3;a<pixels.length;a+=4){hasAlpha ||= pixels[a]<255;partialAlpha ||= pixels[a]>0&&pixels[a]<255;}
    slots.set(name,{hasAlpha,partialAlpha,u0:x/canvas.width,v0:1-(y+tile)/canvas.height,u1:(x+tile)/canvas.width,v1:1-y/canvas.height});
  }
  const blank={u0:(pad+tile/2)/canvas.width,u1:(pad+tile/2)/canvas.width,v0:1-(pad+tile/2)/canvas.height,v1:1-(pad+tile/2)/canvas.height};
  const faces=new Map();for(let i=0;i<palette.length;i++)if(palette[i])faces.set(textureStateKey(palette[i]),bundle.faces[i]?.map(f=>f&&slots.has(f.texture)?{...slots.get(f.texture),tint:f.tint}:null)??null);
  const models=new Map();for(let i=0;i<palette.length;i++)if(palette[i]&&bundle.models?.[i])models.set(textureStateKey(palette[i]),{...bundle.models[i],occludes:bundle.models[i].occludes&&bundle.models[i].quads.every(q=>slots.has(q.texture)&&!slots.get(q.texture).hasAlpha),quads:bundle.models[i].quads.map(q=>({...q,translucent:q.translucent||slots.get(q.texture)?.partialAlpha,style:slots.has(q.texture)?{...slots.get(q.texture),tint:q.tint}:null}))});
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.generateMipmaps=false;
  return {texture,faces,models,blank,count:slots.size,failures};
}
