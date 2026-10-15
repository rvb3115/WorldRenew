import fs from 'node:fs';
import {deflateRawSync,deflateSync,crc32} from 'node:zlib';
export function png(width=16,height=16){
 const chunk=(type,data)=>{const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const raw=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+1+x*4,light=(x+y)%2===0;raw[i]=light?210:70;raw[i+1]=light?140:45;raw[i+2]=light?60:25;raw[i+3]=255;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function zip(file,entries,method=8){const local=[],central=[];let offset=0;for(const [name,value]of entries){const raw=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value)),packed=method===8?deflateRawSync(raw):raw,n=Buffer.from(name),lh=Buffer.alloc(30),ch=Buffer.alloc(46);lh.writeUInt32LE(0x04034b50);lh.writeUInt16LE(20,4);lh.writeUInt16LE(method,8);lh.writeUInt32LE(crc32(raw),14);lh.writeUInt32LE(packed.length,18);lh.writeUInt32LE(raw.length,22);lh.writeUInt16LE(n.length,26);ch.writeUInt32LE(0x02014b50);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(method,10);ch.writeUInt32LE(crc32(raw),16);ch.writeUInt32LE(packed.length,20);ch.writeUInt32LE(raw.length,24);ch.writeUInt16LE(n.length,28);ch.writeUInt32LE(offset,42);local.push(lh,n,packed);central.push(ch,n);offset+=lh.length+n.length+packed.length;}const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);fs.writeFileSync(file,Buffer.concat([...local,dir,end]));return file;}
export const blockAssets=()=>[
 ['assets/minecraft/textures/block/stone.png',png()],
 ['assets/minecraft/textures/block/top.png',png()],
 ['assets/minecraft/textures/block/front.png',png()],
 ['assets/minecraft/models/block/base.json',{textures:{all:'minecraft:block/stone'},elements:[{from:[0,0,0],to:[16,16,16],faces:Object.fromEntries(['east','west','up','down','south','north'].map(n=>[n,{texture:'#all'}]))}]}],
 ['assets/minecraft/models/block/stone.json',{parent:'minecraft:block/base'}],
 ['assets/minecraft/blockstates/stone.json',{variants:{'':{model:'minecraft:block/stone'}}}],
 ['assets/minecraft/models/block/test_log.json',{parent:'minecraft:block/base',textures:{end:'minecraft:block/top'},elements:[{from:[0,0,0],to:[16,16,16],faces:{up:{texture:'#end'},down:{texture:'#end'},east:{texture:'#all'},west:{texture:'#all'},north:{texture:'#all'},south:{texture:'#all'}}}]}],
 ['assets/minecraft/blockstates/test_log.json',{variants:{'axis=x':{model:'minecraft:block/test_log',x:90,y:90},'axis=y':{model:'minecraft:block/test_log'}}}],
 ['assets/minecraft/models/block/furnace.json',{parent:'minecraft:block/base',textures:{front:'minecraft:block/front'},elements:[{from:[0,0,0],to:[16,16,16],faces:{north:{texture:'#front'},south:{texture:'#all'},up:{texture:'#all'},down:{texture:'#all'},east:{texture:'#all'},west:{texture:'#all'}}}]}],
 ['assets/minecraft/blockstates/furnace.json',{variants:{'facing=east,lit=true':{model:'minecraft:block/furnace',y:90},'facing=north,lit=true':{model:'minecraft:block/furnace'}}}]
];
