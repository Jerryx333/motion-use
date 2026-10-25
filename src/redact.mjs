import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// Resolve the same sharp used by HyperFrames; no second native dependency.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('hyperframes/package.json'))('sharp');
export async function redactImage(input, { boxes, out, sigma = 18 } = {}) {
  if (!input || !out || path.resolve(input) === path.resolve(out)) throw new Error('redact requires an input and a different --out PNG path');
  if (path.extname(out).toLowerCase() !== '.png') throw new Error('redact --out must be PNG');
  if (fs.existsSync(out)) throw new Error(`output already exists: ${out}`);
  const source = await sharp(input).rotate().png().toBuffer();
  const {width,height} = await sharp(source).metadata();
  if (!Array.isArray(boxes) || !boxes.length || !Number.isFinite(sigma) || sigma < .3 || sigma > 100) throw new Error('redact requires --box x,y,w,h [--box ...]; sigma .3..100');
  const layers=[];
  for(const box of boxes) {
    const [left,top,widthBox,heightBox]=box;
    if(box.length!==4 || !box.every(Number.isInteger) || left<0 || top<0 || widthBox<1 || heightBox<1 || left+widthBox>width || top+heightBox>height) throw new Error('redact box must contain four integer source pixels within the rotated image');
    layers.push({input:await sharp(source).extract({left,top,width:widthBox,height:heightBox}).blur(sigma).png().toBuffer(),left,top});
  }
  const output=await sharp(source).composite(layers).png().toBuffer();
  fs.writeFileSync(out,output,{flag:'wx'});
  return {ok:true,file:path.resolve(out),boxes,width,height};
}
