import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { quoteVideoPricing, publicVideoPricing, videoPricingError, type VideoPricingInput } from '@/lib/pricing/video';
import { parseSeedanceVideoModel, isSeedanceVideoDuration, seedanceVideoDurationError } from '@/lib/provider/seedance-models';
import { authenticateCodexVideoApi, hasCodexApiAuthSignal, CodexApiAuthError } from '@/lib/integrations/codex';
import type { VideoResolution } from '@/types';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady } from '@/lib/integrations/volcengine-ip';
import { isVolcengineIpModelId, volcengineIpModelResolutions } from '@/lib/integrations/volcengine-ip-models';
import { assertCurrentMultiviewRotationPreset, MultiviewPresetError } from '@/lib/video/multiview-preset.server';
import { getH3ApiSettings, H3_PRESET_OPTIONS, isH3Operational } from '@/lib/integrations/h3';
import { getAiMediaKitApiSettings, isAiMediaKitApiReady } from '@/lib/integrations/aimediakit';
import { resolveVideoPricingContext, issueVideoPricingCredential, savedVideoPricingContextInput } from '@/lib/pricing/video-context';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';

export async function GET(request: NextRequest) {
  return estimate(request);
}
export async function POST(request: NextRequest) {
  try {
    const reader = request.body?.getReader();
    if (!reader) return errorJson('报价输入为空', 400);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 262144) return errorJson('报价输入过大', 400);
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorJson('报价输入无效', 400);
    const url = new URL(request.url);
    for (const field of ['provider', 'model', 'resolution', 'duration', 'tool_version', 'fps', 'multiview_preset_version']) {
      if (body[field] !== undefined) url.searchParams.set(field, String(body[field]));
    }
    return estimate(new NextRequest(url, { headers: request.headers }), body);
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    return errorJson('报价输入无法读取，原参数未改变', 400);
  }
}
async function estimate(request: NextRequest, body?: Record<string, unknown>) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider') || 'seedance';
  if (!['seedance', 'volcengine_ip', 'h3', 'volcengine_mediakit'].includes(provider)) return errorJson('视频接口无效', 400);
  let user;
  try {
    if (hasCodexApiAuthSignal(request)) {
      // Same authenticated normal internal service user as the create route.
      const context = await authenticateCodexVideoApi(request);
      user = context.user;
    } else {
      user = await getSessionUser(request);
      if (provider !== 'volcengine_ip') assertInternalOnly(user, '外部账号无权使用普通生成估价，请使用 IP 生成。');
    }
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    if (error instanceof CodexApiAuthError) return errorJson(error.message, error.status);
    return errorJson('未登录', 401);
  }
  const expectedActor = request.headers.get('x-app-session-user');
  if (expectedActor && expectedActor !== user.id) return NextResponse.json({ error: '账号已变化，请重新确认当前账号后报价；原输入保留', code: 'pricing_actor_changed' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });

  const resolution = (searchParams.get('resolution') || '720p') as VideoResolution;
  const duration = Number(searchParams.get('duration') ?? '5');
  const requestedModel = searchParams.get('model');
  const ipSettings = provider === 'volcengine_ip' ? await getVolcengineIpApiSettings() : null;
  if (provider === 'volcengine_ip' && ((!isVolcengineIpModelId(requestedModel) && requestedModel !== ipSettings?.default_model)
    || !volcengineIpModelResolutions(requestedModel!).includes(resolution))) return errorJson('IP 模型或分辨率无效', 400);
  if (provider === 'volcengine_ip' && (!ipSettings || !isVolcengineIpApiReady(ipSettings))) return errorJson('IP 视频接口尚未配置，请联系管理员', 409);
  if (provider === 'h3') {
    const settings = await getH3ApiSettings();
    if (!isH3Operational(settings) || !H3_PRESET_OPTIONS.some(option => option.id === requestedModel)) return errorJson('H3 当前预设未就绪，请检查机器状态', 409);
  }
  const parsedModel = provider === 'volcengine_ip' || provider === 'h3' ? { ok: true as const, model: requestedModel! }
    : provider === 'volcengine_mediakit' ? { ok: true as const, model: 'enhance-video' } : parseSeedanceVideoModel(requestedModel);
  if (!parsedModel.ok) return errorJson(parsedModel.message, 400);
  if (provider !== 'volcengine_mediakit' && !isSeedanceVideoDuration(duration, parsedModel.model)) return errorJson(seedanceVideoDurationError(parsedModel.model), 400);
  if (!(provider === 'volcengine_mediakit' ? ['240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k'] : ['480p', '720p', '1080p']).includes(resolution)) return errorJson('resolution 无效', 400);
  const toolVersion = searchParams.get('tool_version') || 'standard';
  const fps = searchParams.has('fps') ? Number(searchParams.get('fps')) : null;
  if (provider === 'volcengine_mediakit' && (!['standard', 'professional'].includes(toolVersion)
    || !Number.isFinite(duration) || duration <= 0 || duration > 3600 || fps !== null && (!Number.isInteger(fps) || fps < 15 || fps > 120))) return errorJson('增强视频报价参数无效', 400);
  if (provider === 'volcengine_mediakit' && !isAiMediaKitApiReady(await getAiMediaKitApiSettings())) return errorJson('增强视频接口未就绪', 409);
  const multiviewPresetVersion = searchParams.get('multiview_preset_version');
  let multiviewPresetRevision: number | undefined;
  if (multiviewPresetVersion !== null) {
    try {
      assertInternalOnly(user, '外部账号无权使用3D多视图生成。');
      if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
      if (provider !== 'seedance') return errorJson('3D多视图当前只支持普通视频生成通道。', 400);
      multiviewPresetRevision = (await assertCurrentMultiviewRotationPreset(multiviewPresetVersion)).revision;
    } catch (error) {
      if (error instanceof AuthError || error instanceof MultiviewPresetError) return NextResponse.json({ error: error.message,
        ...(error instanceof MultiviewPresetError ? { code: error.code } : {}) }, {
        status: error.status, headers: { 'Cache-Control': 'private, no-store' },
      });
      return NextResponse.json({ error: '模板提示词暂时无法确认，请重新读取后再报价。' }, {
        status: 503, headers: { 'Cache-Control': 'private, no-store' },
      });
    }
  }

  try {
    if (body?.retry_task_id) {
      if (typeof body.retry_task_id !== 'string') throw new AuthError('原任务编号无效', 400);
      const task = await prisma.videoTask.findUnique({ where: { id: body.retry_task_id } });
      if (!task) throw new AuthError('原任务不存在', 404);
      await assertCanViewTask(user, task);
      if (task.model !== parsedModel.model || task.duration !== duration || task.resolution !== resolution) throw new AuthError('重试报价与原任务不同', 409);
      body = savedVideoPricingContextInput(task);
    }
    const context = body && (body.project_id || body.video_card_id) ? await resolveVideoPricingContext(user, {
      ...body, provider, model: parsedModel.model, resolution, duration,
    }) : undefined;
    const quote = await quoteVideoPricing({ provider: provider as VideoPricingInput['provider'], model: parsedModel.model,
      resolution, duration, toolVersion, fps, context });
    return NextResponse.json({ ...publicVideoPricing(quote), provider, modelId: parsedModel.model,
    ...(context ? { pricing_quote_token: issueVideoPricingCredential(context, quote.revision, quote.pricing.estimatedCost) } : {}),
    ...(multiviewPresetVersion === null ? {} : { multiviewPresetVersion, multiviewPresetRevision }),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    const failure = videoPricingError(error);
    return NextResponse.json({ error: failure?.message || '报价暂时无法确认，请重试；原参数未改变', code: failure?.code || 'pricing_unavailable' },
      { status: failure?.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
