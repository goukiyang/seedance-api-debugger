import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { StudioError } from '@/lib/image-studio/tasks';
import { attachAssetToSiteReferenceImage } from '@/lib/assets/reference-import';
import { normalizeAssets, normalizeRecipe } from '@/lib/template-studio/validation';
import { avatarKey, readAvatar } from './store';
export type AvatarReturnTarget = { kind: 'workspace' | 'video-draft' | 'image-module'; id: string; revision?: number; slotKey?: string | null; capacity: number; currentAssetIds: string[]; sourceSignature: string; imageLimit?: number; role?: 'first_frame' | 'last_frame' | 'reference_image' };
type Ticket = { id: string; target: AvatarReturnTarget; fingerprint: string; expiresAt: string; assetId?: string; applied?: boolean; claimToken?: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function destination(user: SessionUser, target: AvatarReturnTarget, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  if(target.kind==='image-module'){
    const module=await tx.imageStudioModule.findFirst({where:{id:target.id,owner_id:user.id}});
    if(!module && target.id!==`default-${user.id}` || module && module.revision!==target.revision)throw new StudioError('原图片模板版本已变化，请重新选择',409);
    return {fingerprint:hash([target.id,module?.revision??target.revision,module?.updated_at??null]),assetIds:target.currentAssetIds,imageCount:target.currentAssetIds.length,draft:null};
  }
  if (target.kind === 'workspace') {
    const workspace = await tx.workspace.findFirst({ where: { id: target.id, owner_id: user.id, status: 'active' } });
    if (!workspace) throw new StudioError('原工作区已不可用', 409);
    const assets = await tx.workspaceAsset.findMany({ where: { workspace_id: target.id }, orderBy: { sort_order: 'asc' }, include: { asset: { select: { type: true } } } });
    return { fingerprint: hash([workspace.updated_at, assets.map(a => [a.id,a.asset_id,a.reference_image_id,a.role,a.sort_order])]), assetIds: assets.map(a=>a.asset_id), imageCount: assets.filter(a=>a.asset.type==='image').length, draft: null };
  }
  const draft = await tx.videoStudioDraft.findFirst({ where: { id: target.id, owner_user_id: user.id } });
  if (!draft || draft.revision !== target.revision) throw new StudioError('原模块版本已变化，请返回后重新选择', 409);
  const assets = JSON.parse(draft.assets_json) as Array<{assetId:string}>;
  return { fingerprint: hash([draft.revision,draft.assets_json,draft.template_snapshot_json]), assetIds: assets.map(a=>a.assetId), imageCount: 0, draft };
}
export async function createAvatarTicket(user: SessionUser, input: AvatarReturnTarget) {
  if (!input || !['workspace','video-draft','image-module'].includes(input.kind) || typeof input.id !== 'string' || input.id.length > 100 || !Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 12 || !Array.isArray(input.currentAssetIds) || input.currentAssetIds.length > 80 || input.currentAssetIds.some(id=>typeof id!=='string'||id.length>100) || typeof input.sourceSignature !== 'string' || input.sourceSignature.length > 200000) throw new StudioError('返回目标无效');
  if (input.slotKey !== undefined && input.slotKey !== null && (typeof input.slotKey!=='string'||input.slotKey.length>48)) throw new StudioError('目标槽位无效');
  if (input.role && !['first_frame','last_frame','reference_image'].includes(input.role)) throw new StudioError('目标用途无效');
  const target: AvatarReturnTarget = { ...input, sourceSignature: hash(input.sourceSignature), imageLimit: Number.isInteger(input.imageLimit) ? Math.max(1,Math.min(10,input.imageLimit!)) : 10 };
  const state = await destination(user,target);
  if (hash(state.assetIds.slice().sort()) !== hash(input.currentAssetIds.slice().sort())) throw new StudioError('原任务素材尚未保存或已变化，请重新打开素材窗口',409);
  const ticket: Ticket = { id: randomUUID(), target, fingerprint: state.fingerprint, expiresAt: new Date(Date.now()+86400000).toISOString() };
  await prisma.platformSetting.create({ data: { key: avatarKey(user.id,'ticket',ticket.id), value_json:JSON.stringify(ticket),updated_by:user.id } });
  return { id:ticket.id };
}
export async function avatarTicketAction(user:SessionUser,id:string,action:string,assetId?:string,signature?:string,claimToken?:string) {
  if(['choose','ack'].includes(action)&&(typeof assetId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(assetId)))throw new StudioError('返回图片无效');
  if(action==='apply'&&(typeof signature!=='string'||signature.length>200000))throw new StudioError('返回现场无效');
  return prisma.$transaction(async tx=>{
    const ticket = await readAvatar<Ticket>(user.id,'ticket',id,tx);
    const originalJson=ticket?JSON.stringify(ticket):'';
    if (!ticket || new Date(ticket.expiresAt).getTime()<Date.now()) throw new StudioError('来路已失效；图片仍保留在我的素材',409);
    if (action==='read') return { id:ticket.id,chosen:Boolean(ticket.assetId),applied:ticket.applied===true };
    if(action==='choose'&&ticket.applied&&ticket.assetId===assetId)return {chosen:true,applied:true};
    if(action==='choose'&&ticket.claimToken&&ticket.assetId===assetId)return {chosen:true,applied:false};
    if(action==='ack'){
      if(ticket.target.kind!=='image-module'||!ticket.claimToken||ticket.claimToken!==claimToken||ticket.assetId!==assetId)throw new StudioError('本地回填确认无效',409);
      if(ticket.applied)return {applied:true};
      ticket.applied=true;
      const saved=await tx.platformSetting.updateMany({where:{key:avatarKey(user.id,'ticket',id),value_json:originalJson},data:{value_json:JSON.stringify(ticket)}});
      if(!saved.count)throw new StudioError('返回记录已变化，请重新查询',409);
      return {applied:true};
    }
    if (action==='apply' && ticket.applied) return { applied:true,assetId:ticket.assetId };
    if (ticket.applied) throw new StudioError('这次返回已完成，请从原任务重新进入',409);
    const state = await destination(user,ticket.target,tx);
    if (state.fingerprint!==ticket.fingerprint) throw new StudioError('原任务已修改；没有覆盖新编辑，图片仍保留在我的素材',409);
    if (action==='choose') {
      if(ticket.claimToken)throw new StudioError('已有正在确认的回填，不能更换这次图片',409);
      const asset = await tx.asset.findFirst({where:{id:assetId,owner_id:user.id,status:'active',type:'image'}});
      const generated = await tx.imageStudioTask.findFirst({where:{owner_id:user.id,asset_id:asset?.id||'',status:'succeeded',snapshot_json:{contains:'"avatar":'}}});
      if (!asset || !generated) throw new StudioError('这张图片不存在或不属于本账号人物结果',403);
      ticket.assetId=asset.id;
    } else if (action==='apply') {
      if (!signature || hash(signature)!==ticket.target.sourceSignature) throw new StudioError('原页面设置或目标槽位已变化，没有回填；请在素材库重新选择',409);
      const asset = await tx.asset.findFirst({where:{id:ticket.assetId||'',owner_id:user.id,status:'active',type:'image'}});
      if (!asset) throw new StudioError('图片已不可用',409);
      if (state.assetIds.includes(asset.id)) throw new StudioError('图片已经存在，不重复添加',409);
      if(ticket.target.kind==='image-module'){
        ticket.claimToken ||= randomUUID();
        const saved=await tx.platformSetting.updateMany({where:{key:avatarKey(user.id,'ticket',id),value_json:originalJson},data:{value_json:JSON.stringify(ticket)}});
        if(!saved.count)throw new StudioError('回填确认已变化，请重新查询',409);
        return {chosen:true,applied:false,assetId:asset.id,localDraft:true,claimToken:ticket.claimToken};
      } else if (ticket.target.kind==='workspace') {
        if (state.imageCount >= ticket.target.imageLimit! || ticket.target.capacity<1) throw new StudioError('图片容量已满，未替换已有素材',409);
        if(['first_frame','last_frame'].includes(ticket.target.role||'')&&await tx.workspaceAsset.count({where:{workspace_id:ticket.target.id,role:ticket.target.role}}))throw new StudioError('原首尾帧位置已有图片，没有替换已有素材',409);
        await attachAssetToSiteReferenceImage({user,workspaceId:ticket.target.id,sourceLabel:'人物生成',role:ticket.target.role||'reference_image',albumName:'生成工作台参考图',albumDescription:'生成工作台自动归档的参考图',metadataSource:'avatar_return',db:tx},asset.id);
      } else {
        const row=state.draft!;
        const recipe=row.template_snapshot_json?normalizeRecipe(JSON.parse(row.template_snapshot_json).recipe):null;
        const slot=ticket.target.slotKey?recipe?.assetSlots.find(s=>s.key===ticket.target.slotKey):null;
        if (ticket.target.slotKey&&!slot || slot&&!slot.types.includes('image')) throw new StudioError('模板槽位已不可用或不接收图片',409);
        const assets=normalizeAssets([...JSON.parse(row.assets_json),{assetId:asset.id,type:'image',role:slot?.role||'reference',...(slot?{slotKey:slot.key}:{})}],recipe);
        const changed=await tx.videoStudioDraft.updateMany({where:{id:row.id,owner_user_id:user.id,revision:row.revision},data:{assets_json:JSON.stringify(assets),revision:{increment:1},updated_at:new Date()}});
        if (!changed.count) throw new StudioError('模块已变化，未覆盖新编辑',409);
      }
      ticket.applied=true;
    } else throw new StudioError('返回操作无效');
    const saved=await tx.platformSetting.updateMany({where:{key:avatarKey(user.id,'ticket',id),value_json:originalJson},data:{value_json:JSON.stringify(ticket)}});
    if(!saved.count)throw new StudioError('回填已被另一页处理，请查询原返回',409);
    return { chosen:true,applied:ticket.applied===true };
  },{timeout:15000});
}
