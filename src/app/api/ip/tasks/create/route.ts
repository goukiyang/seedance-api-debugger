import { NextRequest } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { authenticateCodexVideoApi, CodexApiAuthError, hasCodexApiAuthSignal, webRequestSource } from '@/lib/integrations/codex';
import { createIpVideo } from '@/lib/video/ip-create';

export async function POST(request: NextRequest) {
  if (hasCodexApiAuthSignal(request)) {
    try {
      const context = await authenticateCodexVideoApi(request);
      return createIpVideo(request, context.user, context.source, await request.json());
    } catch (error) {
      if (error instanceof CodexApiAuthError) return errorJson(error.message, error.status);
      throw error;
    }
  }
  let user;
  try { user = await getSessionUser(request); }
  catch { return errorJson('请先登录后再生成视频', 401); }
  return createIpVideo(request, user, webRequestSource(request), await request.json());
}
