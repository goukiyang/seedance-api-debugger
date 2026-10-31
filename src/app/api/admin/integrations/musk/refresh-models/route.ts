import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  fetchMuskUpstreamModels,
  getMuskApiSettings,
  isMuskApiReady,
} from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

/** 一键刷新上游 OpenAI 兼容 /models，供后台勾选白名单。 */
export async function POST(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) {
      return NextResponse.json(
        { ok: false, error: 'Musk API 未启用或缺少配置，无法刷新模型列表' },
        { status: 503 },
      );
    }
    const ids = await fetchMuskUpstreamModels(settings, { force: true });
    if (!ids) {
      return NextResponse.json(
        { ok: false, error: '上游模型列表拉取失败' },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      models: ids.map((id) => ({ id, label: id, available: true })),
      count: ids.length,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/MuskIntegration] refresh-models failed:', error);
    return NextResponse.json({ error: '刷新模型列表失败' }, { status: 500 });
  }
}
