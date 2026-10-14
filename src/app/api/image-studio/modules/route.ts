import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listStudioModules, saveStudioModule, chooseStudioModuleSharing, deleteStudioModule, deleteStudioGroup, studioModuleDeletionStatus, studioModuleDTOForUser, StudioModuleError } from '@/lib/image-studio/modules';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { openSharedStudioModule, studioSharedOpenStatus, StudioSharingError } from '@/lib/image-studio/shared-contract';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
import { StudioFixedReferenceError } from '@/lib/image-studio/fixed-references';
import { StudioReferencePolicyError } from '@/lib/image-studio/reference-policy';
import { ModuleCoverError } from '@/lib/image-studio/module-cover';
import { StudioSharingPreferenceError } from '@/lib/image-studio/module-sharing-preference';
import type { StudioOpenNotApplied, StudioRetiredOpenProof } from '@/lib/image-studio/shared-types';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function businessError(error: unknown) {
  return error instanceof StudioModuleError || error instanceof StudioSharingError || error instanceof StudioSharingPreferenceError || error instanceof StudioStyleError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof ModuleCoverError;
}
function errorReason(error: unknown) {
  return error instanceof StudioSharingError ? error.reasonCode : (error as StudioModuleError).status === 403 ? 'access-revoked' : 'state-conflict';
}
function retiredOpenProjection(error: unknown): { retiredOpen: StudioRetiredOpenProof } | Record<string, never> {
  if (!(error instanceof StudioSharingError)) return {};
  const proof = (error as StudioSharingError & { retiredOpen?: Partial<StudioRetiredOpenProof> }).retiredOpen;
  if (!proof || proof.version !== 1 || proof.status !== 'workspace-deleted'
    || typeof proof.actorId !== 'string' || !proof.actorId || typeof proof.presetId !== 'string' || !proof.presetId
    || typeof proof.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(proof.requestId)
    || typeof proof.moduleId !== 'string' || !proof.moduleId) return {};
  // Project only the typed proof attached by the receipt/tombstone branch.
  // HTTP status or a generic business failure is never a retirement proof.
  return { retiredOpen: { version: 1, status: 'workspace-deleted', actorId: proof.actorId, presetId: proof.presetId,
    requestId: proof.requestId, moduleId: proof.moduleId } };
}
function openNotAppliedProjection(error: unknown): { openCommandOutcome: StudioOpenNotApplied } | Record<string, never> {
  if (!(error instanceof StudioSharingError)) return {};
  const proof = (error as StudioSharingError & { openCommandOutcome?: Partial<StudioOpenNotApplied> }).openCommandOutcome;
  if (!proof || proof.status !== 'not-applied' || typeof proof.actorId !== 'string' || !proof.actorId
    || typeof proof.presetId !== 'string' || !proof.presetId || typeof proof.requestId !== 'string'
    || !/^[A-Za-z0-9:_-]{1,160}$/.test(proof.requestId)) return {};
  return { openCommandOutcome: { status: 'not-applied', actorId: proof.actorId, presetId: proof.presetId, requestId: proof.requestId } };
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', reasonCode: 'login-required' }, { status: 401, headers: privateHeaders });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  const idsValue = request.nextUrl.searchParams.get('ids');
  const ids = idsValue ? Array.from(new Set(idsValue.split(','))) : undefined;
  if (ids && (ids.length > 12 || ids.some(id => !id || id.length > 100))) return NextResponse.json({ error: '模块读取参数无效' }, { status: 400, headers: privateHeaders });
  try {
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'open-status') return NextResponse.json(await studioSharedOpenStatus(user,
      request.nextUrl.searchParams.get('presetId') || '', request.nextUrl.searchParams.get('requestId')), { headers: privateHeaders });
    if (mode === 'delete-status') return NextResponse.json(await studioModuleDeletionStatus(user.id,
      request.nextUrl.searchParams.get('id'), request.nextUrl.searchParams.get('requestId')), { headers: privateHeaders });
    if (mode) return NextResponse.json({ error: '模块读取方式无效' }, { status: 400, headers: privateHeaders });
    return NextResponse.json(await listStudioModules(user.id, request.nextUrl.searchParams.get('cursor') || undefined, user.role === 'admin', ids, user), { headers: privateHeaders });
  }
  catch (error) {
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message, reasonCode: errorReason(error) }, { status: (error as StudioModuleError).status, headers: privateHeaders });
    console.error('[image-studio/modules] read failed', { name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : undefined });
    return NextResponse.json({ error: '模块读取失败，请重试', reasonCode: 'read-unavailable' }, { status: 503, headers: privateHeaders });
  }
}
async function save(request: NextRequest, createOnly: boolean) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', reasonCode: 'login-required' }, { status: 401, headers: privateHeaders });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '模块内容无效' }, { status: 400, headers: privateHeaders });
    if (!createOnly && body.action === 'set-sharing-preference') return NextResponse.json(await chooseStudioModuleSharing(user.id, body), { headers: privateHeaders });
    if (createOnly && body.action === 'open-shared') {
      if (typeof body.presetId !== 'string' || !body.presetId || body.presetId.length > 160) return NextResponse.json({ error: '共享模板编号无效' }, { status: 400, headers: privateHeaders });
      const workspace = await openSharedStudioModule(user, body.presetId, body.requestId, undefined, { explicitSelection: body.explicitSelection === true });
      return NextResponse.json(await studioModuleDTOForUser(user, workspace.id), { headers: privateHeaders });
    }
    return NextResponse.json(await saveStudioModule(user.id, body, createOnly, user.role === 'admin', undefined, user), { headers: privateHeaders });
  }
  catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模块内容无效' }, { status: 400, headers: privateHeaders });
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message, reasonCode: errorReason(error),
      ...retiredOpenProjection(error),
      ...openNotAppliedProjection(error),
      ...(error instanceof StudioModuleError && error.commandOutcome ? { commandOutcome: error.commandOutcome } : {}) },
    { status: (error as StudioModuleError).status, headers: privateHeaders });
    return NextResponse.json({ error: '保存未确认，草稿仍保留，请保留原请求编号查询', reasonCode: 'read-unavailable' }, { status: 503, headers: privateHeaders });
  }
}
export const POST = (request: NextRequest) => save(request, true);
export const PUT = (request: NextRequest) => save(request, false);

export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', reasonCode: 'login-required' }, { status: 401, headers: privateHeaders });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权操作图片模板', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '模板参数无效' }, { status: 400, headers: privateHeaders });
    if (body?.action === 'delete-group') return NextResponse.json(await deleteStudioGroup(user, body), { headers: privateHeaders });
    if (body.action !== undefined && body.action !== 'delete-module') return NextResponse.json({ error: '删除方式无效' }, { status: 400, headers: privateHeaders });
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId)) {
      return NextResponse.json({ error: '请刷新页面后删除，并保留有效的原请求编号', reasonCode: 'state-conflict' }, { status: 428, headers: privateHeaders });
    }
    return NextResponse.json(await deleteStudioModule(user.id, body.id, body.revision, body.requestId), { headers: privateHeaders });
  } catch (error) {
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message, reasonCode: errorReason(error),
      ...(error instanceof StudioModuleError && error.commandOutcome ? { commandOutcome: error.commandOutcome } : {}) }, { status: (error as StudioModuleError).status, headers: privateHeaders });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模板参数无效' }, { status: 400, headers: privateHeaders });
    return NextResponse.json({ error: '删除结果未确认，请保留原请求编号查询，不会自动重新删除', reasonCode: 'read-unavailable' }, { status: 503, headers: privateHeaders });
  }
}
