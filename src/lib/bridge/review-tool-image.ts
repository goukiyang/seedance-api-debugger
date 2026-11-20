import { ReviewError, ReviewMaterialError } from './gpt-review';
export type FileRef={file_id?:string;download_url?:string;mime_type?:string};
export async function reviewImage(file:FileRef,remaining:number){
  if(typeof file.file_id!=='string'||!file.file_id||typeof file.download_url!=='string')throw new ReviewError('没有收到 ChatGPT 交回的完整图片');
  let u:URL;try{u=new URL(file.download_url);}catch{throw new ReviewError('图片地址无效');}
  if(u.protocol!=='https:'||u.port||u.username||u.password||!/(^|\.)oaiusercontent\.com$/.test(u.hostname))throw new ReviewError('请把改好的图片作为原对话附件交回');
  const res=await fetch(u,{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000)});
  const mime=(res.headers.get('content-type')||file.mime_type||'').split(';')[0].trim().toLowerCase();
  if(!res.ok||!res.body){await res.body?.cancel();throw new ReviewError('图片传输结果尚未确认，请保留同一附件重试，不要重新生成');}
  if(!['image/png','image/jpeg','image/webp'].includes(mime)){
    await res.body.cancel();throw new ReviewMaterialError('本轮图片格式不支持，请交回 PNG、JPEG 或 WebP 主成品','unsupported_image_format');}
  if(Number(res.headers.get('content-length'))>remaining){
    await res.body.cancel();throw new ReviewMaterialError('这版成品图超过 2 MB，请交回同内容的清晰缩略副本','image_too_large');}
  const r=res.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await r.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>remaining)throw new ReviewMaterialError('这版成品图超过 2 MB，请交回同内容的清晰缩略副本','image_too_large');chunks.push(part.value);}}finally{await r.cancel().catch(()=>{});}
  return {bytes,src:'data:'+mime+';base64,'+Buffer.concat(chunks).toString('base64')};
}
