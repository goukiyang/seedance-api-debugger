import { ReviewError } from './gpt-review';
export type FileRef={file_id?:string;download_url?:string;mime_type?:string};
export async function reviewImage(file:FileRef,remaining:number){
  if(typeof file.file_id!=='string'||!file.file_id||typeof file.download_url!=='string')throw new ReviewError('没有收到 ChatGPT 交回的完整图片');
  let u:URL;try{u=new URL(file.download_url);}catch{throw new ReviewError('图片地址无效');}
  if(u.protocol!=='https:'||u.port||u.username||u.password||!/(^|\.)oaiusercontent\.com$/.test(u.hostname))throw new ReviewError('请把改好的图片作为原对话附件交回');
  const res=await fetch(u,{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000)});
  const mime=(res.headers.get('content-type')||file.mime_type||'').split(';')[0];
  if(!res.ok||!res.body||!['image/png','image/jpeg','image/webp'].includes(mime)||Number(res.headers.get('content-length'))>remaining){
    await res.body?.cancel();throw new ReviewError('这版成品图未完整收到或超过 2 MB');}
  const r=res.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await r.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>remaining)throw new ReviewError('这版成品图超过 2 MB');chunks.push(part.value);}}finally{await r.cancel().catch(()=>{});}
  return {bytes,src:'data:'+mime+';base64,'+Buffer.concat(chunks).toString('base64')};
}
