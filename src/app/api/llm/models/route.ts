import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getMuskApiSettings, resolveMuskChatModels } from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    }
    const settings = await getMuskApiSettings();
    const ids = await resolveMuskChatModels(settings);
    return NextResponse.json({
      ok: true,
      models: ids.map((id) => ({ id, label: id })),
      default: settings.default_model,
    });
  } catch (error) {
    console.error('[llm/models]', error);
    return NextResponse.json({ error: '读取模型列表失败', ok: false }, { status: 500 });
  }
}
