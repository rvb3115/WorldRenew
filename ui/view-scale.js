// Camera distance only. Never transform meshes, selected coordinates, or saved blocks.
export const REFERENCE_DISTANCE=264, SCALE_STEPS=20;
export const MAX_DISTANCE=REFERENCE_DISTANCE*2**SCALE_STEPS;
export const clampDistance=d=>Math.max(REFERENCE_DISTANCE,Math.min(MAX_DISTANCE,d));
export const distanceForSlider=value=>REFERENCE_DISTANCE*2**(SCALE_STEPS-Math.max(0,Math.min(SCALE_STEPS,value)));
export const sliderForDistance=distance=>SCALE_STEPS-Math.log2(clampDistance(distance)/REFERENCE_DISTANCE);
export const scaleLabel=distance=>`1:${(clampDistance(distance)/REFERENCE_DISTANCE).toLocaleString(undefined,{maximumFractionDigits:1})}`;
export function fitSelectionDistance(bounds,{aspect=1,yaw=0,tilt=.83,fov=45,targetY=128,minY=-64,maxY=320}={}) {
  if(!bounds || ![bounds.minX,bounds.maxX,bounds.minZ,bounds.maxZ,aspect,yaw,tilt,targetY,minY,maxY].every(Number.isFinite) || aspect<=0)throw new Error('Invalid selection view bounds.');
  const halfX=(bounds.maxX-bounds.minX+1)*8,halfZ=(bounds.maxZ-bounds.minZ+1)*8;
  const vertical=Math.tan(fov*Math.PI/360),horizontal=vertical*aspect;
  let distance=REFERENCE_DISTANCE;
  for(const x of [-halfX,halfX])for(const z of [-halfZ,halfZ])for(const y of [minY-targetY,maxY-targetY]){
    const right=x*Math.cos(yaw)-z*Math.sin(yaw);
    const up=-x*Math.sin(yaw)*Math.cos(tilt)+y*Math.sin(tilt)-z*Math.cos(yaw)*Math.cos(tilt);
    const toward=x*Math.sin(yaw)*Math.sin(tilt)+y*Math.cos(tilt)+z*Math.cos(yaw)*Math.sin(tilt);
    distance=Math.max(distance,toward+Math.abs(right)*1.18/horizontal,toward+Math.abs(up)*1.18/vertical);
  }
  return clampDistance(distance);
}
