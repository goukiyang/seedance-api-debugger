import { ReviewError } from './gpt-review';

export async function boundedJson(req:Request,limit:number):Promise<Record<string,unknown>> {
  if (!req.body || Number(req.headers.get('content-length')) > limit) throw new ReviewError('提交的材料过大或为空',413);
  const reader=req.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try {
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw new ReviewError('提交的材料过大',413);chunks.push(part.value);}
  } finally {await reader.cancel().catch(()=>{});}
  try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed;}
  catch{throw new ReviewError('验收请求格式不正确');}
}
