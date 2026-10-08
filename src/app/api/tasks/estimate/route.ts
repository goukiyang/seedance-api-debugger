import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { calculateEstimatedCost } from '@/lib/pricing';
import { parseSeedanceVideoModel, isSeedanceVideoDuration, seedanceVideoDurationError } from '@/lib/provider/seedance-models';
import { authenticateCodexVideoApi, hasCodexApiAuthSignal, CodexApiAuthError } from '@/lib/integrations/codex';
import type { VideoResolution } from '@/types';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady } from '@/lib/integrations/volcengine-ip';
import { isVolcengineIpModelId, volcengineIpModelResolutions } from '@/lib/integrations/volcengine-ip-models';

export async function GET(request: NextRequest) {
  let user;
  try {
    if (hasCodexApiAuthSignal(request)) {
      // Same authenticated normal internal service user as the create route.
      const context = await authenticateCodexVideoApi(request);
      user = context.user;
    } else {
      user = await getSessionUser(request);
      assertInternalOnly(user, '外部账号无权使用普通生成估价，请使用 IP 生成。');
    }
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    if (error instanceof CodexApiAuthError) return errorJson(error.message, error.status);
    return errorJson('未登录', 401);
  }

  const { searchParams } = new URL(request.url);
  const resolution = (searchParams.get('resolution') || '720p') as VideoResolution;
  const duration = Number(searchParams.get('duration') ?? '5');
  const provider = searchParams.get('provider') || 'seedance';
  if (!['seedance', 'volcengine_ip'].includes(provider)) return errorJson('视频接口无效', 400);
  const requestedModel = searchParams.get('model');
  if (provider === 'volcengine_ip' && (!isVolcengineIpModelId(requestedModel)
    || !volcengineIpModelResolutions(requestedModel!).includes(resolution))) return errorJson('IP 模型或分辨率无效', 400);
  if (provider === 'volcengine_ip' && !isVolcengineIpApiReady(await getVolcengineIpApiSettings())) return errorJson('IP 视频接口尚未配置，请联系管理员', 409);
  const parsedModel = provider === 'volcengine_ip' ? { ok: true as const, model: requestedModel! } : parseSeedanceVideoModel(requestedModel);
  if (!parsedModel.ok) return errorJson(parsedModel.message, 400);
  if (!isSeedanceVideoDuration(duration, parsedModel.model)) return errorJson(seedanceVideoDurationError(parsedModel.model), 400);
  if (!['480p', '720p', '1080p'].includes(resolution)) return errorJson('resolution 无效', 400);

  const pricing = calculateEstimatedCost(resolution, duration, parsedModel.model);

  return NextResponse.json({ ...pricing, provider, modelId: parsedModel.model }, { headers: { 'Cache-Control': 'private, no-store' } });
}
