import { canAccessImageTemplates, isExternalImageStudioActor } from '@/lib/image-studio/access';
import { traceHttpRequest } from '@/lib/performance/request-trace';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { applyStudioPreset, linkStudioQuickPreset, listStudioPresets, manageStudioPreset, saveStudioPreset, setStudioPresetSharing, studioSharingCommandStatus, studioPresetDeletionStatus, studioPresetLifecycleHistory } from '@/lib/image-studio/presets';
import { StudioModuleError } from '@/lib/image-studio/modules';
import { StudioTaskSettingsError } from '@/lib/image-studio/task-settings';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
import { StudioSharingError, studioParameterCopyStatus } from '@/lib/image-studio/shared-contract';
import { StudioFixedReferenceError } from '@/lib/image-studio/fixed-references';
import { PrivatePromptAccessError } from '@/lib/security/private-prompt-identity.server';
import { PrivatePromptError } from '@/lib/security/private-prompts.server';
import { StudioReferencePolicyError } from '@/lib/image-studio/reference-policy';
import { ModuleCoverError } from '@/lib/image-studio/module-cover';
import { listAdminStudioDefinitionDirectory, readStudioTemplateAuthorContact, readStudioTemplateDefinition,
  StudioDefinitionReadError } from '@/lib/image-studio/definition-read';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  return traceHttpRequest('studio.presets', request.headers, async () => {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', reasonCode: 'login-required' }, { status: 401, headers: privateHeaders });
  if (!canAccessImageTemplates(user)) return NextResponse.json({ error: '无权使用图片模板', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  try {
    const moduleId = request.nextUrl.searchParams.get('moduleId') ?? undefined;
    const presetId = request.nextUrl.searchParams.get('presetId') ?? undefined;
    if (presetId && presetId.length > 160 || moduleId && moduleId.length > 160) return NextResponse.json({ error: '模板读取参数无效' }, { status: 400, headers: privateHeaders });
    const mode = request.nextUrl.searchParams.get('mode');
    if (isExternalImageStudioActor(user) && mode) return NextResponse.json({ error: '无权读取模板原件管理资料', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
    if (mode === 'parameter-copy-status') return NextResponse.json(await studioParameterCopyStatus(user, request.nextUrl.searchParams.get('requestId')), { headers: privateHeaders });
    if (mode === 'definition') {
      if (Boolean(presetId) === Boolean(moduleId)) return NextResponse.json({ error: '模板定义读取参数无效' }, { status: 400, headers: privateHeaders });
      return NextResponse.json(await readStudioTemplateDefinition(user, { presetId, moduleId }), { headers: privateHeaders });
    }
    if (mode === 'admin-directory') {
      return NextResponse.json(await listAdminStudioDefinitionDirectory(user, { cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
        q: request.nextUrl.searchParams.get('q') ?? undefined,
        limit: request.nextUrl.searchParams.has('limit') ? Number(request.nextUrl.searchParams.get('limit')) : undefined }), { headers: privateHeaders });
    }
    if (mode === 'author-contact') {
      if (Boolean(presetId) === Boolean(moduleId)) return NextResponse.json({ error: '作者读取参数无效' }, { status: 400, headers: privateHeaders });
      return NextResponse.json(await readStudioTemplateAuthorContact(user, { presetId, moduleId }), { headers: privateHeaders });
    }
    if (mode === 'delete-status') {
      if (!presetId) return NextResponse.json({ error: '删除查询参数无效' }, { status: 400, headers: privateHeaders });
      return NextResponse.json(await studioPresetDeletionStatus(user, presetId, request.nextUrl.searchParams.get('requestId')), { headers: privateHeaders });
    }
    if (mode === 'command-status') return NextResponse.json(await studioSharingCommandStatus(user, request.nextUrl.searchParams.get('requestId')), { headers: privateHeaders });
    if (mode === 'history') {
      if (!presetId) return NextResponse.json({ error: '模板记录参数无效' }, { status: 400, headers: privateHeaders });
      return NextResponse.json(await studioPresetLifecycleHistory(user, presetId, request.nextUrl.searchParams.get('cursor') ?? undefined), { headers: privateHeaders });
    }
    if (mode) return NextResponse.json({ error: '模板读取方式无效' }, { status: 400, headers: privateHeaders });
    return NextResponse.json({ presets: await listStudioPresets(user, moduleId, presetId) }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof PrivatePromptAccessError) return NextResponse.json({ error: error.message, reasonCode: 'access-revoked' }, { status: error.status, headers: privateHeaders });
    if (error instanceof PrivatePromptError) return NextResponse.json({ error: error.message, reasonCode: 'read-unavailable' }, { status: error.status, headers: privateHeaders });
    if (error instanceof StudioTaskSettingsError) return NextResponse.json({ error: error.message, reasonCode: 'state-conflict' }, { status: error.status, headers: privateHeaders });
    if (error instanceof StudioModuleError || error instanceof StudioStyleError || error instanceof StudioSharingError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof ModuleCoverError || error instanceof StudioDefinitionReadError) return NextResponse.json({ error: error.message, reasonCode: error instanceof StudioSharingError || error instanceof StudioDefinitionReadError ? error.reasonCode : 'state-conflict',
      ...(error instanceof StudioModuleError && error.commandOutcome ? { commandOutcome: error.commandOutcome } : {}) }, { status: error.status, headers: privateHeaders });
    return NextResponse.json({ error: '模板读取失败，请重试', reasonCode: 'read-unavailable' }, { status: 503, headers: privateHeaders });
  }
  });
}
export async function POST(request: NextRequest) {
  return traceHttpRequest('studio.presets', request.headers, async () => {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', reasonCode: 'login-required' }, { status: 401, headers: privateHeaders });
  if (!canAccessImageTemplates(user)) return NextResponse.json({ error: '无权使用图片模板', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  if (isExternalImageStudioActor(user)) return NextResponse.json({ error: '外部账号不能创建或修改模板定义', reasonCode: 'access-revoked' }, { status: 403, headers: privateHeaders });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '模板内容无效' }, { status: 400, headers: privateHeaders });
    if (body.action === 'delete' && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId))) {
      return NextResponse.json({ error: '请刷新页面后删除，并保留有效的原请求编号', reasonCode: 'state-conflict' }, { status: 428, headers: privateHeaders });
    }
    if (body.action === 'rename' || body.action === 'delete') return NextResponse.json(await manageStudioPreset(user, String(body.presetId || ''), body.revision, body.action, body.name, { requestId: body.requestId, entryPoint: body.entryPoint }), { headers: privateHeaders });
    if (body.action === 'replace') return NextResponse.json(await saveStudioPreset(user, body, true), { headers: privateHeaders });
    if (body.action === 'add-quick') return NextResponse.json(await linkStudioQuickPreset(user, String(body.moduleId || ''), String(body.presetId || '')), { headers: privateHeaders });
    if (body.action === 'apply') return NextResponse.json(await applyStudioPreset(user, String(body.presetId || '')), { headers: privateHeaders });
    if (body.action === 'set-sharing') {
      if (typeof body.isShared !== 'boolean') return NextResponse.json({ error: '模板共享设置无效' }, { status: 400, headers: privateHeaders });
      const updated = await setStudioPresetSharing(user, String(body.presetId || ''), body.isShared, body.revision, body.requestId, body.entryPoint);
      return NextResponse.json({ id: updated.id, isShared: updated.is_shared, receipt: updated.receipt, current: updated.current }, { headers: privateHeaders });
    }
    return NextResponse.json(await saveStudioPreset(user, body), { headers: privateHeaders });
  } catch (error) {
    if (error instanceof StudioTaskSettingsError) return NextResponse.json({ error: error.message, reasonCode: 'state-conflict' }, { status: error.status, headers: privateHeaders });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模板内容无效' }, { status: 400, headers: privateHeaders });
    if (error instanceof StudioModuleError || error instanceof StudioStyleError || error instanceof StudioSharingError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof ModuleCoverError) return NextResponse.json({ error: error.message, reasonCode: error instanceof StudioSharingError ? error.reasonCode : 'state-conflict',
      ...(error instanceof StudioModuleError && error.commandOutcome ? { commandOutcome: error.commandOutcome } : {}) }, { status: error.status, headers: privateHeaders });
    return NextResponse.json({ error: '模板操作结果未确认，请保留原请求编号查询', reasonCode: 'read-unavailable' }, { status: 503, headers: privateHeaders });
  }
  });
}
