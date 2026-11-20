import { NextRequest, NextResponse } from 'next/server';
import { getBridgeUser, isAllowedShellOrigin } from '@/lib/bridge/panel-token';
import { confirmSource } from '@/lib/bridge/review-pairing';
import { boundedJson } from '@/lib/bridge/review-request';
import { checkedScope, pendingRecaps, reviewStatus, summary, details, getTask, judgeReview, listReviews, ReviewError, startReview, updateReview } from '@/lib/bridge/gpt-review';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 150;
const headers = { 'Cache-Control':'private, no-store', Vary:'Cookie, Authorization' };
const reply = (data: unknown,status=200) => NextResponse.json(data,{status,headers});


async function handle(req:NextRequest,write:boolean) {
  try {
    const user=await getBridgeUser(req);
    if(!user)return reply({ok:false,error:'请先登录 SD2'},401);
    if(req.headers.get('x-sd2-user-id')!==user.id)return reply({ok:false,error:'SD2 账号已切换'},409);
    const scope=checkedScope(req.nextUrl.searchParams.get('scope'));
    if(!write){
      const id=req.nextUrl.searchParams.get('id');
      if(id)return reply({ok:true,task:req.nextUrl.searchParams.get('summary')==='1'?await reviewStatus(user.id,scope,id):details((await getTask(user.id,scope,id)).task)});
      if(req.nextUrl.searchParams.get('recaps')==='1')return reply({ok:true,...await pendingRecaps(user.id,scope)});
      const offset=Number(req.nextUrl.searchParams.get('offset')||0);
      if(!Number.isSafeInteger(offset)||offset<0)throw new ReviewError('页码无效');
      return reply({ok:true,...await listReviews(user.id,scope,offset)});
    }
    const origin=req.headers.get('origin');
    if(!origin||!isAllowedShellOrigin(origin)&&origin!==req.nextUrl.origin)throw new ReviewError('来源不允许',403);
    const b=await boundedJson(req,6*1024*1024);
    if(b.scope!==scope)throw new ReviewError('ChatGPT 工作区已变化',409);
    if(b.op==='create'){
      const task=await startReview(user.id,b);
      return reply({ok:true,task:summary(task.kind==='art'?task:await judgeReview(user.id,await getTask(user.id,scope,task.id)))});
    }
    const saved=await getTask(user.id,scope,String(b.id||''));
    if(b.op==='judge' && b.version!==saved.task.version)return reply({ok:true,task:summary(saved.task)});
    const task=b.op==='judge'?await judgeReview(user.id,saved):b.op==='confirm'?await confirmSource(user.id,saved.task,b):await updateReview(user.id,saved,b);
    const recovered=b.op==='recover'&&task.art?.wake?.delivery===task.delivery&&['delivering','awaiting'].includes(task.phase);
    return reply({ok:true,task:summary(task),...(b.op==='claim'||recovered?{delivery:task.delivery}:{}),...(recovered?{instructions:task.art?.instructions}:{})});
  } catch(error) {
    return reply({ok:false,error:error instanceof ReviewError?error.message:'暂时无法读取或保存验收，请保留当前任务重试'},error instanceof ReviewError?error.status:503);
  }
}
export const GET=(req:NextRequest)=>handle(req,false);
export const POST=(req:NextRequest)=>handle(req,true);
