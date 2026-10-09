import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { getImageStudioSettings, saveImageStudioSettings, imageStudioSettingsPayload, StudioSettingsClearConfirmationError, IMAGE_STUDIO_MODELS } from '@/lib/image-studio/settings';
import { getImageGenerationChannels, selectImageGenerationSettings, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { supportsStudioFourToOne } from '@/lib/image-generation/resolution';
import { imageBillingReadinessPayload } from '@/lib/image-studio/billing-readiness';
import { parseStudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { studioFourToOneIssue } from '@/lib/image-generation/resolution';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const settings = await getImageStudioSettings();
    const channels = await getImageGenerationChannels();
    const modelReady = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => {
      const api = selectImageGenerationSettings(channels, model);
      return [model, isStudioImageGenerationProvider(api.provider) && isImageGenerationApiReady(api)];
    }));
    const providerReady = Object.values(modelReady).some(Boolean);
    const modelFourToOne = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, supportsStudioFourToOne(model, selectImageGenerationSettings(channels, model).provider)]));
    return NextResponse.json({ ...imageStudioSettingsPayload(settings, user.role === 'admin'), providerReady, modelReady, modelFourToOne,
      billingReadiness: await imageBillingReadinessPayload() }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch {
    return NextResponse.json({ error: '读取设置失败，请重试' }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 20000))
      || (body.confirmContextClear !== undefined && typeof body.confirmContextClear !== 'boolean')
      || (body.model !== undefined && !IMAGE_STUDIO_MODELS.includes(body.model)) || !Number.isInteger(body.revision) || body.revision < 0
      || (body.prices !== undefined && (!body.prices || typeof body.prices !== 'object' || Array.isArray(body.prices)
        || IMAGE_STUDIO_MODELS.some(model => body.prices[model] !== null
          && (!Number.isInteger(body.prices[model]) || body.prices[model] < 0 || body.prices[model] > 100000))))) {
      return NextResponse.json({ error: '设置无效，上下文最多 20000 字' }, { status: 400 });
    }
    let templateDefaults;
    if (body.templateDefaults !== undefined) {
      try { templateDefaults = parseStudioTemplateDefaults(body.templateDefaults); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '统一默认设置无效' }, { status: 400 }); }
      if (templateDefaults.aspectRatio === '4:1') {
        const channels = await getImageGenerationChannels();
        const api = selectImageGenerationSettings(channels, templateDefaults.model);
        const issue = studioFourToOneIssue(templateDefaults.aspectRatio, supportsStudioFourToOne(templateDefaults.model, api.provider));
        if (issue) return NextResponse.json({ error: issue }, { status: 400 });
      }
    }
    const current = await getImageStudioSettings();
    const settings = await saveImageStudioSettings({ context: body.context ?? current.context, revision: body.revision, model: body.model ?? current.model,
      prices: body.prices ?? current.prices, ...(templateDefaults === undefined ? {} : { templateDefaults }) }, user.id, { confirmContextClear: body.confirmContextClear === true });
    if (!settings) return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '设置内容无效' }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof StudioSettingsClearConfirmationError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json({ error: '保存失败，修改仍保留在当前页面，请重试' }, { status: 500 });
  }
}
