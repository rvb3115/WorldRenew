import fs from 'node:fs';
import path from 'node:path';
import {makeBlockWorld,writeBlockChunk,state} from './transfer-fixtures.js';
export function placementWorld(root,options={}){
  const ox=options.originX??0,oz=options.originZ??0;
  makeBlockWorld(root,{version:'26.2',dataVersion:4903,...options,x:ox,z:oz});
  const regions=new Map();
  for(let z=oz;z<oz+3;z++)for(let x=ox;x<ox+4;x++){
    const tmp=path.join(root,'fixture.mca');writeBlockChunk(tmp,{dataVersion:4903,block:()=>state('stone'),...options,x,z});
    const bytes=fs.readFileSync(tmp),record=bytes.subarray(8192),slot=((x%32+32)%32)+((z%32+32)%32)*32,key=`r.${Math.floor(x/32)}.${Math.floor(z/32)}.mca`;
    if(!regions.has(key))regions.set(key,{header:Buffer.alloc(8192),records:[],offset:2});const r=regions.get(key);
    r.header.writeUInt32BE(r.offset*256+record.length/4096,slot*4);r.header.writeUInt32BE(1234,4096+slot*4);r.offset+=record.length/4096;r.records.push(record);fs.unlinkSync(tmp);
  }
  for(const[name,r]of regions)fs.writeFileSync(path.join(root,'dimensions/minecraft/overworld/region',name),Buffer.concat([r.header,...r.records]));return root;
}
