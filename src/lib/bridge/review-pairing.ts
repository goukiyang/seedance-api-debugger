import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { getTask, bindReviewConnection, ReviewError, type ReviewTask } from './gpt-review';
const PREFIX='bridge_gpt_review_link:';
export const reviewResource='ui://sd2-review/confirm-source-v1.html';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const uuid=/^[a-f0-9-]{36}$/i;
export async function pairSource(owner:string,delivery:string,connection:string){
  if(!uuid.test(delivery))throw new ReviewError('验收单号无效');
  const ticket=await prisma.userPreference.findUnique({where:{user_id_key:{user_id:owner,key:'bridge_gpt_review_ticket:'+delivery}}});
  if(!ticket)throw new ReviewError('当前账号没有这轮验收',404);
  const ref=JSON.parse(ticket.value_json),{task}=await getTask(owner,ref.scope,ref.id);
  if(task.delivery!==delivery||!['delivering','awaiting'].includes(task.phase)||task.connected&&task.connected!==connection)throw new ReviewError('请在发起本轮的原对话中确认',409);
  if(task.connected===connection)return {linked:true};
  const key=PREFIX+digest(delivery+':'+connection),now=Date.now();
  const record={delivery,connection,nonce:randomUUID(),expires:now+300000};
  const filter={user_id:owner,key};
  let row=await prisma.userPreference.upsert({where:{user_id_key:filter},create:{...filter,value_json:JSON.stringify(record)},update:{}});
  let proof=JSON.parse(row.value_json);
  if(proof.expires<=now){
    await prisma.userPreference.updateMany({where:{...filter,value_json:row.value_json},data:{value_json:JSON.stringify(record)}});
    row=await prisma.userPreference.findUniqueOrThrow({where:{user_id_key:filter}});proof=JSON.parse(row.value_json);
  }
  // Only the original tool component sees this. The model never receives its confirmation nonce.
  return {linked:false,proof:{link:key.slice(PREFIX.length),nonce:proof.nonce,delivery}};
}
export async function confirmSource(owner:string,task:ReviewTask,b:Record<string,unknown>){
  if(b.device!==task.binding.device||b.cid!==task.binding.cid||typeof b.link!=='string'||!/^[a-f0-9]{64}$/.test(b.link)||
     typeof b.nonce!=='string'||typeof b.delivery!=='string'||task.delivery!==b.delivery)throw new ReviewError('来源或本轮回执不匹配',409);
  const where={user_id:owner,key:PREFIX+b.link},row=await prisma.userPreference.findUnique({where:{user_id_key:where}});
  if(!row)throw new ReviewError('这次原页面核对已经失效',409);
  const proof=JSON.parse(row.value_json);
  if(proof.nonce!==b.nonce||proof.delivery!==task.delivery||proof.expires<=Date.now())throw new ReviewError('来源确认已过期，请在原对话重新连接',409);
  return bindReviewConnection(owner,task.scope,task.id,b.delivery,proof.connection);
}
export const componentHTML=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><small>SD2 正在核对发起验收的原对话</small><script>
const origins=['https://chatgpt.com','https://chat.openai.com'];
let proof,attempt=0;
function announce(meta){if(meta?.sd2ReviewProof&&meta.sd2ReviewProof.nonce!==proof?.nonce){proof=meta.sd2ReviewProof;attempt=0;}if(proof&&attempt++<12){for(const origin of origins)window.top.postMessage({type:'sd2b-review-origin',proof},origin);}}
function send(m){window.parent.postMessage({...m,jsonrpc:'2.0'},'*');}
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.id===1&&m.result)send({method:'ui/notifications/initialized'});if(m?.method==='ui/notifications/tool-result')announce(m.params?._meta);});
addEventListener('openai:set_globals',e=>announce(e.detail?.globals?.toolResponseMetadata));
announce(window.openai?.toolResponseMetadata);
send({id:1,method:'ui/initialize',params:{appInfo:{name:'SD2 验收',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'}});
setInterval(()=>announce(window.openai?.toolResponseMetadata),800);
</script></body></html>`;
