import { NextRequest,NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { StudioError } from '@/lib/image-studio/tasks';
import { createAvatarTicket,avatarTicketAction } from '@/lib/avatar-random/handoff';
export const dynamic='force-dynamic';
export async function POST(req:NextRequest){
  const user=await getSession();if(!user||user.status!=='active'||!canUseCompanyTemplates(user))return NextResponse.json({error:'当前账号无权使用人物生成'},{status:403});
  try { const body=await req.json();return NextResponse.json(body.action==='create'?await createAvatarTicket(user,body.target):await avatarTicketAction(user,body.id,body.action,body.assetId,body.signature,body.claimToken),{headers:{'Cache-Control':'no-store'}}); }
  catch(e){return NextResponse.json({error:e instanceof StudioError?e.message:'返回未确认，原图片保留，请重新选择'},{status:e instanceof StudioError?e.status:503});}
}
