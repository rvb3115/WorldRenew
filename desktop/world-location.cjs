const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
function directory(value){try{return typeof value==='string'&&path.isAbsolute(value)&&fs.statSync(value).isDirectory();}catch{return false;}}
function defaultWorldDirectory({platform=process.platform,home,appData,env=process.env,remembered}={}){
  if(directory(remembered))return remembered;
  const standard=platform==='darwin'?path.join(home,'Library','Application Support','minecraft','saves'):platform==='win32'?path.join(env.APPDATA||appData||path.join(home,'AppData','Roaming'),'.minecraft','saves'):path.join(home,'.minecraft','saves');
  if(directory(standard))return standard;
  return directory(home)?home:undefined;
}
function rememberedDirectory(userData){
  try{const file=path.join(userData,'world-location.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)return undefined;const data=JSON.parse(fs.readFileSync(file,'utf8'));return data.schemaVersion===1&&directory(data.directory)?data.directory:undefined;}catch{return undefined;}
}
function rememberWorldDirectory(userData,world){
  if(!directory(world))return;
  // A chooser preference lives only in app data, never alongside a save.
  for(let p=path.resolve(userData);;p=path.dirname(p)){if(fs.existsSync(path.join(p,'level.dat'))||fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Unsafe app preference directory.');if(p===path.dirname(p))break;}
  fs.mkdirSync(userData,{recursive:true});const file=path.join(userData,'world-location.json'),temp=`${file}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,JSON.stringify({schemaVersion:1,directory:world})+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
module.exports={defaultWorldDirectory,rememberedDirectory,rememberWorldDirectory};
