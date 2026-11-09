import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchMuskUpstreamModels, getMuskApiSettings, isMuskApiReady, resolveMuskChatModels } from '@/lib/integrations/musk';
import { readModelAccessSettings } from '@/lib/pricing/model-access.server';
import { supplementaryModelEnabled } from '@/lib/pricing/model-availability-contract';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    }
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) {
      return NextResponse.json({ ok: false, error: '当前 API 尚未启用或配置，暂无法更新模型列表' }, { status: 503 });
    }
    const upstream = await fetchMuskUpstreamModels(settings, { force: request.nextUrl.searchParams.get('refresh') === '1' });
    if (upstream === null) {
      return NextResponse.json({ ok: false, error: '模型列表更新失败，原选择已保留，请稍后再更新' }, { status: 502 });
    }
    const access = await readModelAccessSettings();
    const ids = (await resolveMuskChatModels(settings, upstream)).filter(model => supplementaryModelEnabled(access, 'text', model));
    return NextResponse.json({
      ok: true,
      models: ids.map((id) => ({ id, label: id })),
      default: ids.includes(settings.default_model) ? settings.default_model : '',
    });
  } catch (error) {
    console.error('[llm/models]', error);
    return NextResponse.json({ error: '读取模型列表失败', ok: false }, { status: 500 });
  }
}
