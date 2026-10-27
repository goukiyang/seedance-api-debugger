import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { getImageStudioSettings, saveImageStudioSettings, imageStudioSettingsPayload, StudioSettingsClearConfirmationError, IMAGE_STUDIO_MODELS } from '@/lib/image-studio/settings';
import { getImageGenerationChannelOptions, getImageGenerationChannels, ImageGenerationChannelError, selectImageGenerationSettings, isImageGenerationApiReady, isStudioImageGenerationProvider, imageGenerationSupportsStudioFourToOne } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { imageBillingReadinessPayload } from '@/lib/image-studio/billing-readiness';
import { parseStudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { getPricingImageChannelOptions } from '@/lib/pricing/image';
import { studioTaskSettingsWriterEnabled } from '@/lib/image-studio/task-settings-storage';
import { STUDIO_TASK_SETTINGS_PROTOCOL } from '@/lib/image-studio/task-settings';
import { PrivatePromptAccessError } from '@/lib/security/private-prompt-identity.server';
import { PrivatePromptError } from '@/lib/security/private-prompts.server';
import { readPrivateGlobalEditor, savePrivateGlobalDraft, savePrivateGlobalEditor, privateGlobalEditorStatus } from '@/lib/image-studio/private-settings-editor.server';
import { PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';

export const dynamic = 'force-dynamic';

async function settingsForModel(channels: Awaited<ReturnType<typeof getImageGenerationChannels>>, model: typeof IMAGE_STUDIO_MODELS[number]) {
  const channelId = await resolveImageGenerationRequestChannel(model);
  try {
    return selectImageGenerationSettings(channels, model, channelId || 'original');
  } catch (error) {
    if (error instanceof ImageGenerationChannelError && error.status === 404) return null;
    throw error;
  }
}

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'private-editor' || mode === 'private-save-status' || mode === 'private-draft-status') {
      const result = mode === 'private-editor' ? await readPrivateGlobalEditor(user.id)
        : await privateGlobalEditorStatus(user.id, request.nextUrl.searchParams.get('requestId') || '', mode === 'private-draft-status');
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
    const settings = await getImageStudioSettings();
    const channels = await getImageGenerationChannels();
    const selectedSettings = await Promise.all(IMAGE_STUDIO_MODELS.map(async model => [model, await settingsForModel(channels, model)] as const));
    const byModel = new Map(selectedSettings);
    const modelReady = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => {
      const api = byModel.get(model);
      return [model, Boolean(api && isStudioImageGenerationProvider(api.provider) && isImageGenerationApiReady(api))];
    }));
    const providerReady = Object.values(modelReady).some(Boolean);
    const modelFourToOne = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, byModel.get(model)
      ? imageGenerationSupportsStudioFourToOne(byModel.get(model)!, model) : false]));
    return NextResponse.json({ ...await imageStudioSettingsPayload(settings, user.id, request.nextUrl.searchParams.get('private') === '1'), providerReady, modelReady, modelFourToOne, imageChannels: await getPricingImageChannelOptions(),
      taskSettingsProtocol: studioTaskSettingsWriterEnabled() ? STUDIO_TASK_SETTINGS_PROTOCOL : null,
      billingReadiness: await imageBillingReadinessPayload() }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof PrivatePromptAccessError || error instanceof PrivatePromptError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json({ error: '读取设置失败，请重试' }, { status: 503 });
  }
});

export const PUT = apiRoute({ access: 'admin', rateLimit: false }, async function PUT(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json();
    if (body?.action === 'save-private-definition' || body?.action === 'save-private-draft') {
      const result = body.action === 'save-private-definition' ? await savePrivateGlobalEditor(user.id, body)
        : await savePrivateGlobalDraft(user.id, body);
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
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
    }
    const current = await getImageStudioSettings();
    const settings = await saveImageStudioSettings({ context: body.context ?? current.context, revision: body.revision, model: body.model ?? current.model,
      prices: body.prices ?? current.prices, ...(templateDefaults === undefined ? {} : { templateDefaults }) }, user.id,
    { confirmContextClear: body.confirmContextClear === true });
    if (!settings) return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json(await imageStudioSettingsPayload(settings, user.id), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '设置内容无效' }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof PrivateDraftConflict) return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    if (error instanceof PrivatePromptAccessError || error instanceof PrivatePromptError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof StudioSettingsClearConfirmationError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: '设置已在其他页面更新，请重新读取后修改' }, { status: 409 });
    return NextResponse.json({ error: '保存失败，修改仍保留在当前页面，请重试' }, { status: 500 });
  }
});
