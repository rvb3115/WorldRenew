import { resolveModel } from './models.js';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { requireThat } from './errors.js';

// Read selected ZIP/JAR entries in memory. Never extract paths or execute archive content.
export class AssetArchive {
  constructor(file) {
    const st=fs.lstatSync(file);
    requireThat(st.isFile()&&!st.isSymbolicLink()&&st.size<=512*1024*1024,'ASSET_ARCHIVE','Choose a regular Minecraft JAR or resource-pack ZIP under 512 MiB.');
    this.fd=fs.openSync(file,'r');this.size=st.size;this.entries=new Map();this.cache=new Map();this.expanded=0;
    try {
      const tail=this.read(Math.max(0,this.size-65557),Math.min(this.size,65557));let end=-1;
      for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
      requireThat(end>=0,'ASSET_ZIP','Not a complete ZIP/JAR archive.');
      const count=tail.readUInt16LE(end+10),bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
      requireThat(tail.readUInt16LE(end+4)===0&&tail.readUInt16LE(end+6)===0&&count===tail.readUInt16LE(end+8)&&count<65535&&bytes<=32*1024*1024&&offset+bytes<=this.size-tail.length+end,'ASSET_ZIP','Multi-disk, ZIP64 or oversized asset indexes are not supported.');
      const directory=this.read(offset,bytes);let at=0;
      for(let n=0;n<count;n++){
        requireThat(at+46<=directory.length&&directory.readUInt32LE(at)===0x02014b50,'ASSET_ZIP','Damaged asset index.');
        const nameSize=directory.readUInt16LE(at+28),extra=directory.readUInt16LE(at+30),comment=directory.readUInt16LE(at+32),next=at+46+nameSize+extra+comment;
        requireThat(next<=directory.length,'ASSET_ZIP','Truncated asset index.');
        const name=directory.toString('utf8',at+46,at+46+nameSize);
        if(name.startsWith('assets/')){
          requireThat(!name.includes('\\')&&!name.split('/').includes('..')&&!this.entries.has(name),'ASSET_PATH','Unsafe or duplicate asset path.');
          this.entries.set(name,{flags:directory.readUInt16LE(at+8),method:directory.readUInt16LE(at+10),crc:directory.readUInt32LE(at+16),compressed:directory.readUInt32LE(at+20),expanded:directory.readUInt32LE(at+24),offset:directory.readUInt32LE(at+42)});
        }
        at=next;
      }
      requireThat(at===directory.length,'ASSET_ZIP','Unexpected data in asset index.');
      requireThat([...this.entries.keys()].some(n=>/^assets\/[a-z0-9_.-]+\/textures\/block\/.+\.png$/.test(n)),'ASSET_EMPTY','This archive has no Minecraft block textures. Choose a client JAR or Java resource pack.');
    } catch(e){this.close();throw e;}
  }
  read(offset,length){requireThat(Number.isSafeInteger(offset)&&length>=0&&offset>=0&&offset+length<=this.size,'ASSET_ZIP','Asset data lies outside the archive.');const out=Buffer.alloc(length);requireThat(fs.readSync(this.fd,out,0,length,offset)===length,'ASSET_ZIP','Archive changed or was truncated.');return out;}
  get(name){
    if(this.cache.has(name))return this.cache.get(name);const e=this.entries.get(name);if(!e)return null;
    requireThat(!(e.flags&1)&&[0,8].includes(e.method)&&e.compressed<=4*1024*1024&&e.expanded<=4*1024*1024,'ASSET_LIMIT','Encrypted, unsupported or oversized texture entry.');
    requireThat(this.expanded+e.expanded<=32*1024*1024,'ASSET_LIMIT','Texture request exceeds the 32 MiB decoded asset budget.');
    const header=this.read(e.offset,30);requireThat(header.readUInt32LE(0)===0x04034b50&&header.readUInt16LE(8)===e.method,'ASSET_ZIP','Invalid local asset header.');
    const nameLength=header.readUInt16LE(26),extra=header.readUInt16LE(28);
    requireThat(this.read(e.offset+30,nameLength).toString('utf8')===name,'ASSET_ZIP','Asset entry name mismatch.');
    const packed=this.read(e.offset+30+nameLength+extra,e.compressed),data=e.method===8?inflateRawSync(packed,{maxOutputLength:4*1024*1024}):packed;
    requireThat(data.length===e.expanded&&crc32(data)===e.crc,'ASSET_ZIP','Asset checksum or size mismatch.');
    this.expanded+=data.length;requireThat(this.expanded<=32*1024*1024,'ASSET_LIMIT','Texture request exceeds the 32 MiB decoded asset budget.');this.cache.set(name,data);return data;
  }
  json(name){const b=this.get(name);if(!b)return null;requireThat(b.length<=256*1024,'ASSET_LIMIT','Asset model JSON is too large.');return JSON.parse(b.toString('utf8'));}
  close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;}}
}
const names=['east','west','up','down','south','north'];
const vectors=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
function resource(ref,kind){requireThat(typeof ref==='string'&&/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(ref)&&!ref.split('/').includes('..'),'ASSET_REF','Invalid Minecraft asset reference.');const [namespace,relative]=ref.includes(':')?ref.split(':'):['minecraft',ref];return `assets/${namespace}/${kind}/${relative}`;}
function rotate(vector,x=0,y=0){let [a,b,c]=vector;for(let n=0;n<x/90;n++)[b,c]=[-c,b];for(let n=0;n<y/90;n++)[a,c]=[-c,a];return [a,b,c];}
export function resolveFaces(archive,state){
  const definition=archive.json(resource(state.Name,'blockstates')+'.json');
  const variant=definition?.variants&&Object.entries(definition.variants).find(([key])=>key===''||key.split(',').every(pair=>{const[k,v]=pair.split('=');return state.Properties?.[k]===v;}))?.[1];
  const chosen=Array.isArray(variant)?variant[0]:variant;
  const readModel=(ref,seen=new Set())=>{requireThat(seen.size<24&&!seen.has(ref),'ASSET_MODEL','Cyclic or overly deep block model.');seen.add(ref);const model=archive.json(resource(ref,'models')+'.json');if(!model)return null;const parent=model.parent&&!model.parent.startsWith('builtin/')?readModel(model.parent,seen):null;return {...parent,...model,textures:{...parent?.textures,...model.textures},elements:model.elements??parent?.elements};};
  const model=chosen?.model?readModel(chosen.model):null;
  const resolve=ref=>{const seen=new Set();if(ref&&typeof ref==='object')ref=ref.sprite;while(typeof ref==='string'&&ref.startsWith('#')){requireThat(seen.size<24&&!seen.has(ref),'ASSET_MODEL','Cyclic texture reference.');seen.add(ref);ref=model?.textures?.[ref.slice(1)];if(ref&&typeof ref==='object')ref=ref.sprite;}return ref?resource(ref,'textures')+'.png':null;};
  const output=Array(6).fill(null),rx=chosen?.x??0,ry=chosen?.y??0;
  requireThat([rx,ry].every(v=>[0,90,180,270].includes(v)),'ASSET_MODEL','Unsupported model rotation.');
  for(const element of model?.elements??[])for(const [name,face]of Object.entries(element.faces??{})){
    const index=names.indexOf(name);if(index<0)continue;const vector=rotate(vectors[index],rx,ry),dest=vectors.findIndex(v=>v.every((n,i)=>n===vector[i]));
    if(!output[dest]&&face.texture)output[dest]={texture:resolve(face.texture),tint:face.tintindex!==undefined};
  }
  const fallback=resolve(model?.textures?.particle??model?.textures?.all??model?.textures?.side??model?.textures?.texture);
  // Fluids and multipart blocks may not have an ordinary model. Direct-name texture fallback is explicit.
  const direct=resource(state.Name,'textures').replace('/textures/','/textures/block/')+'.png';
  const fluid=state.Name==='minecraft:water'?'assets/minecraft/textures/block/water_still.png':state.Name==='minecraft:lava'?'assets/minecraft/textures/block/lava_still.png':null;
  const texture=fallback??fluid??(archive.entries.has(direct)?direct:null);
  return output.map(f=>f??(texture?{texture,tint:state.Name==='minecraft:water'}:null));
}
export function pngInfo(data){
  requireThat(data.length>=33&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR','ASSET_PNG','Invalid PNG texture.');
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  requireThat(width>0&&width<=512&&height>=width&&height%width===0&&height<=8192&&width*height<=1048576,'ASSET_PNG','Texture dimensions exceed limits or use an unsupported frame layout.');return {width,height};
}
export function textureBundle(file,palette,fallbackFile=null){
  requireThat(Array.isArray(palette)&&palette.length<=4097,'ASSET_PALETTE','Too many block states requested for textures.');
  const primary=new AssetArchive(file);let fallback=null;const images={},warnings=[],faces=[],models=[];let pixels=0;
  try{
    fallback=fallbackFile&&fallbackFile!==file?new AssetArchive(fallbackFile):null;
    const archive={entries:new Map([...(fallback?.entries??[]),...primary.entries]),get:name=>primary.entries.has(name)?primary.get(name):fallback?.get(name)??null,json:name=>primary.entries.has(name)?primary.json(name):fallback?.json(name)??null};
    for(const state of palette){
      if(!state||['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(state.Name)){faces.push(null);models.push(null);continue;}
      try{
        const resolved=resolveFaces(archive,state);
        const loadFace=face=>{if(!face?.texture)return null;if(!images[face.texture]){requireThat(Object.keys(images).length<512,'ASSET_LIMIT','More than 512 unique textures requested.');const bytes=archive.get(face.texture);if(!bytes)return null;const info=pngInfo(bytes);requireThat(pixels+info.width*info.height<=16*1024*1024,'ASSET_LIMIT','Textures exceed the decoded pixel budget.');pixels+=info.width*info.height;images[face.texture]={...info,url:`data:image/png;base64,${bytes.toString('base64')}`};}return face;};
        const resolvedFaces=resolved.map(loadFace);
        let model=null;
        try{model=resolveModel(archive,state);if(model){for(const quad of model.quads)loadFace(quad);if(models.reduce((n,m)=>n+(m?.quads.length??0),0)+model.quads.length>32768)throw new Error('Preview model face budget exceeded.');}}
        catch(e){model=null;if(warnings.length<12)warnings.push(`${state.Name}: ${e.message}`);}
        faces.push(resolvedFaces);models.push(model);
      }catch(e){faces.push(null);models.push(null);if(warnings.length<12)warnings.push(`${state.Name}: ${e.message}`);}

    }
    return {faces,models,images,warnings,source:path.basename(file),texturedStates:faces.filter((f,i)=>f?.some(Boolean)||models[i]?.quads.some(q=>images[q.texture])).length};
  }finally{primary.close();fallback?.close();}
}
export function installedTextureSource(home,platform,version){
  const base=platform==='darwin'?path.join(home,'Library/Application Support/minecraft/versions'):platform==='win32'?path.join(process.env.APPDATA??path.join(home,'AppData/Roaming'),'.minecraft/versions'):path.join(home,'.minecraft/versions');
  if(!fs.existsSync(base))return null;
  const candidates=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&/^\d+(?:\.\d+){1,2}$/.test(d.name)).map(d=>d.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  for(const name of [version,...candidates])if(typeof name==='string'&&/^\d+(?:\.\d+){1,2}$/.test(name)){const file=path.join(base,name,`${name}.jar`);if(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink())return {file,label:`Minecraft ${name}`,version:name};}
  return null;
}
