import {deflateSync} from 'node:zlib';
import {requireThat} from './errors.js';
/** Rebuild a validated region in a disposable copy. Untouched records retain every byte. */
export function replaceRegionRecords(original,replacements){
  requireThat(original.length>=8192&&original.length<=256*1024*1024,'REGION_SIZE','Unsupported region size for copy placement.');
  const header=Buffer.from(original.subarray(0,8192)),records=[];let sector=2;
  for(let slot=0;slot<1024;slot++){
    const location=original.readUInt32BE(slot*4),offset=location>>>8,count=location&255;let record;
    if(replacements.has(slot)){
      requireThat(location!==0,'REGION_MISSING','Placement cannot create missing chunks.');
      requireThat(!(original[offset*4096+4]&128),'REGION_EXTERNAL','Replacing external chunk records is not supported yet.');
      const payload=deflateSync(replacements.get(slot)),sectors=Math.ceil((payload.length+5)/4096);requireThat(sectors<=255,'REGION_EXTERNAL','New chunk requires external storage; placement is blocked.');
      record=Buffer.alloc(sectors*4096);record.writeUInt32BE(payload.length+1);record[4]=2;payload.copy(record,5);
    }else if(location){requireThat(offset>=2&&count>0&&(offset+count)*4096<=original.length,'REGION_ALLOCATION','Invalid existing region allocation.');record=original.subarray(offset*4096,(offset+count)*4096);}
    if(record){requireThat(sector<0x1000000,'REGION_SIZE','Region allocation limit exceeded.');header.writeUInt32BE(sector*256+record.length/4096,slot*4);records.push(record);sector+=record.length/4096;}
  }
  return Buffer.concat([header,...records]);
}
