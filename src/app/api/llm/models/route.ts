import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { effectiveMuskDefaultModel, getMuskApiSettings, resolveMuskChatModels } from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

/** `?refresh=1` 跳过 5 分钟缓存，重新向上游拉模型。 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    }
    const settings = await getMuskApiSettings();
    const ids = await resolveMuskChatModels(settings, { force: request.nextUrl.searchParams.get('refresh') === '1' });
    return NextResponse.json({
      ok: true,
      models: ids.map((id) => ({ id, label: id })),
      default: effectiveMuskDefaultModel(settings, ids),
    });
  } catch (error) {
    console.error('[llm/models]', error);
    return NextResponse.json({ error: '读取模型列表失败', ok: false }, { status: 500 });
  }
}
