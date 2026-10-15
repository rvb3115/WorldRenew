import {parseNBT, modifiedUTF8, NBT_LIMITS} from './nbt.js';
import {requireThat} from './errors.js';

// Leaves retain original payload bytes, including floating-point NaN bit patterns.
// Compounds retain ordered named tags; lists retain their exact element type.
export function readTypedNBT(bytes){
  parseNBT(bytes);let at=0;
  const take=n=>{const b=bytes.subarray(at,at+n);at+=n;return b;};
  const string=()=>modifiedUTF8(take(take(2).readUInt16BE()));
  function read(type){
    const start=at;let value,elementType;
    switch(type){
      case 1:value=take(1).readInt8();break;case 2:value=take(2).readInt16BE();break;case 3:value=take(4).readInt32BE();break;
      case 4:value=take(8).readBigInt64BE().toString();break;case 5:value=take(4).readFloatBE();break;case 6:value=take(8).readDoubleBE();break;
      case 7:value=take(take(4).readInt32BE());break;case 8:value=string();break;
      case 9:elementType=take(1)[0];value=Array.from({length:take(4).readInt32BE()},()=>read(elementType));break;
      case 10:value=[];for(;;){const t=take(1)[0];if(!t)break;const name=string();value.push({...read(t),name});}break;
      case 11:value=Array.from({length:take(4).readInt32BE()},()=>take(4).readInt32BE());break;
      case 12:value=Array.from({length:take(4).readInt32BE()},()=>take(8).readBigInt64BE().toString());break;
    }
    return {type,value,...(elementType===undefined?{}:{elementType}),...(type===9||type===10?{}:{raw:bytes.subarray(start,at)})};
  }
  take(1);const name=string();return {...read(10),name};
}
export const tag=(type,value,elementType)=>({type,value,...(elementType===undefined?{}:{elementType})});
export const field=(compound,name)=>compound?.type===10?compound.value.find(t=>t.name===name):undefined;
export function setField(compound,name,node){requireThat(compound.type===10,'NBT_TYPE','Expected compound.');const i=compound.value.findIndex(t=>t.name===name);if(i<0)compound.value.push({...node,name});else compound.value[i]={...node,name};}
export function removeField(compound,name){compound.value=compound.value.filter(t=>t.name!==name);}
export function plain(node){if(!node)return undefined;if(node.type===10)return Object.fromEntries(node.value.map(n=>[n.name,plain(n)]));if(node.type===9)return node.value.map(plain);return node.value;}
function utf(s){
  const bytes=[];for(let i=0;i<s.length;i++){const n=s.charCodeAt(i);if(n>0&&n<128)bytes.push(n);else if(n<2048)bytes.push(0xc0|(n>>6),0x80|(n&63));else bytes.push(0xe0|(n>>12),0x80|((n>>6)&63),0x80|(n&63));}
  requireThat(bytes.length<=65535,'NBT_STRING','NBT string too long.');const out=Buffer.alloc(2+bytes.length);out.writeUInt16BE(bytes.length);Buffer.from(bytes).copy(out,2);return out;
}
export function writeTypedNBT(root){
  let count=0,total=0;const parts=[];
  const put=b=>{total+=b.length;requireThat(total<=NBT_LIMITS.bytes,'NBT_SIZE','Encoded NBT exceeds limit.');parts.push(b);};
  const number=(bytes,method,value)=>{const b=Buffer.alloc(bytes);b[method](value);put(b);};
  function write(n,depth){
    requireThat(depth<=64&&++count<=1000000,'NBT_LIMIT','NBT encoding limit exceeded.');
    if(n.raw&&n.type!==9&&n.type!==10){put(n.raw);return;}
    switch(n.type){
      case 1:number(1,'writeInt8',n.value);break;case 2:number(2,'writeInt16BE',n.value);break;case 3:number(4,'writeInt32BE',n.value);break;
      case 4:number(8,'writeBigInt64BE',BigInt(n.value));break;case 5:number(4,'writeFloatBE',n.value);break;case 6:number(8,'writeDoubleBE',n.value);break;
      case 7:number(4,'writeInt32BE',n.value.length);put(Buffer.from(n.value));break;case 8:put(utf(n.value));break;
      case 9:requireThat(n.value.every(v=>v.type===n.elementType),'NBT_TYPE','Mixed NBT list.');number(1,'writeUInt8',n.elementType);number(4,'writeInt32BE',n.value.length);for(const v of n.value)write(v,depth+1);break;
      case 10:for(const v of n.value){number(1,'writeUInt8',v.type);put(utf(v.name));write(v,depth+1);}put(Buffer.from([0]));break;
      case 11:number(4,'writeInt32BE',n.value.length);for(const v of n.value)number(4,'writeInt32BE',v);break;
      case 12:number(4,'writeInt32BE',n.value.length);for(const v of n.value)number(8,'writeBigInt64BE',BigInt(v));break;
      default:throw Error('Unsupported typed NBT tag.');
    }
  }
  requireThat(root.type===10,'NBT_ROOT','Expected compound root.');put(Buffer.from([10]));put(utf(root.name??''));write(root,0);const bytes=Buffer.concat(parts);parseNBT(bytes);return bytes;
}
export const compound=value=>tag(10,Object.entries(value).map(([name,n])=>({...n,name})));
