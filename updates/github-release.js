import {assetURL} from './manifest.js';
import {parseVersion} from './version.js';
export function githubConfigured(config){return config?.source==='github-releases' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository??'');}
export function githubReleaseURL(repository,id){if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid GitHub release ID.');return `https://api.github.com/repos/${repository}/releases/${id}`;}
export function verifyGitHubRelease(release,config,{platform,arch}){
  if(!githubConfigured(config))throw new Error('GitHub release source is not configured.');
  const version=release.tag_name?.replace(/^v/,'');const parsed=parseVersion(version);
  if(release.draft!==false||typeof release.prerelease!=='boolean'||release.prerelease!==Boolean(parsed.pre.length)||release.url!==githubReleaseURL(config.repository,release.id))throw new Error('GitHub release identity or channel mismatch.');
  if(!Array.isArray(release.assets)||release.assets.length>100||typeof release.body!=='string')throw new Error('Invalid GitHub release metadata.');
  const names=platform==='darwin'&&arch==='arm64'?[`WorldRenew-${version}-macos-arm64.app.zip`]:platform==='win32'&&arch==='x64'?[`WorldRenew-${version}-windows-x64-setup-local-test.exe`,`WorldRenew-${version}-windows-x64-portable.exe`]:[];
  const name=names.find(n=>release.assets.some(a=>a.name===n)),assets=release.assets.filter(a=>a.name===name);
  if(!name||assets.length!==1)throw new Error('No unique supported package for this platform and architecture.');
  const asset=assets[0],url=assetURL(config.repository,release.tag_name,name);
  if(asset.state!=='uploaded'||asset.browser_download_url!==url||!Number.isSafeInteger(asset.id)||asset.id<=0||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>2*1024**3||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??''))throw new Error('Package is missing a trusted GitHub SHA-256 digest, size, or asset identity.');
  return {schemaVersion:1,repository:config.repository,tag:release.tag_name,version,channel:release.prerelease?'beta':'stable',notes:release.body.slice(0,50000),verification:'github-sha256',releaseId:release.id,package:{id:asset.id,name,platform,arch,size:asset.size,sha256:asset.digest.slice(7),url,format:platform==='darwin'?'zip':'exe'}};
}
