import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { getImageStudioSettings, saveImageStudioSettings, IMAGE_STUDIO_MODELS } from '@/lib/image-studio/settings';
import { getImageGenerationApiSettings, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const settings = await getImageStudioSettings();
    const imageApi = await getImageGenerationApiSettings();
    const providerReady = isStudioImageGenerationProvider(imageApi.provider) && isImageGenerationApiReady(imageApi);
    return NextResponse.json({ model: settings.model, prices: settings.prices, ...(user.role === 'admin' ? {
      context: settings.context, revision: settings.revision, contextConfigured: Boolean(settings.context.trim()),
    } : {
      revision: settings.revision, contextConfigured: Boolean(settings.context.trim()),
    }), providerReady }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '读取设置失败，请重试' }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.context !== 'string' || body.context.length > 20000
      || (body.model !== undefined && !IMAGE_STUDIO_MODELS.includes(body.model)) || !Number.isInteger(body.revision) || body.revision < 0
      || (body.prices !== undefined && (!body.prices || typeof body.prices !== 'object' || Array.isArray(body.prices)
        || IMAGE_STUDIO_MODELS.some(model => body.prices[model] !== null
          && (!Number.isInteger(body.prices[model]) || body.prices[model] < 0 || body.prices[model] > 100000))))) {
      return NextResponse.json({ error: '设置无效，上下文最多 20000 字' }, { status: 400 });
    }
    const current = await getImageStudioSettings();
    const settings = await saveImageStudioSettings({ ...current, ...body, model: body.model ?? current.model, prices: body.prices ?? current.prices }, user.id);
    if (!settings) return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '设置内容无效' }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json({ error: '保存失败，修改仍保留在当前页面，请重试' }, { status: 500 });
  }
}
