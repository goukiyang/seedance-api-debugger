import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { imageBillingIntent } from '@/lib/image-studio/billing-readiness';
import { IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageGenerationChannelId } from '@/lib/integrations/image-generation-channel';
import { ImageGenerationDefaultRoutesError, getImageGenerationDefaultRoutes } from '@/lib/integrations/image-generation-defaults';
import {
  IMAGE_GENERATION_API_SETTING_KEY,
  buildImageGenerationApiSettingsPatch,
  getImageGenerationApiSettings,
  getImageGenerationChannelOptions,
  getManagedImageGenerationChannels,
  isImageGenerationApiReady,
  saveImageGenerationApiSettings,
  createManagedImageGenerationChannel,
  updateManagedImageGenerationChannel,
  archiveManagedImageGenerationChannel,
  restoreManagedImageGenerationChannel,
  setImageGenerationModelDefaultRoute,
  updateLegacyImageGenerationModelApi,
  hasLegacyImageGenerationModelApiKey,
  ImageGenerationChannelError,
  getImageModelApiForms,
  saveImageModelApiForm,
  readImageModelApiSaveReceipt,
} from '@/lib/integrations/image-generation';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

const FLUXPORT_FLARE_MODEL = 'gpt-image-2.5-flare' as const;

async function getManagedChannelPresets() {
  try {
    return await prisma.$transaction(async tx => {
      const settings = await getImageStudioSettings(tx);
      const billingIntent = await imageBillingIntent(tx);
      const fixedPoints = settings.prices[FLUXPORT_FLARE_MODEL];
      const actualBillingSelected = billingIntent.enabled && billingIntent.enabledModels.includes(FLUXPORT_FLARE_MODEL);
      return {
        fluxportFlareFixedPoints: !actualBillingSelected && typeof fixedPoints === 'number'
          && Number.isSafeInteger(fixedPoints) && fixedPoints >= 0 ? fixedPoints : null,
      };
    });
  } catch {
    return { fluxportFlareFixedPoints: null };
  }
}

function safeConfigDto(settings: Awaited<ReturnType<typeof getImageGenerationApiSettings>>) {
  return {
    enabled: settings.enabled,
    ready: isImageGenerationApiReady(settings),
    provider: settings.provider,
    base_url: settings.base_url,
    default_model: settings.default_model,
    api_key_configured: Boolean(settings.api_key),
    timeout_ms: settings.timeout_ms,
    max_outputs_per_request: settings.max_outputs_per_request,
    default_ratio: settings.default_ratio,
    default_size: settings.default_size,
    output_format: settings.output_format,
    response_format: settings.response_format,
    watermark: settings.watermark,
    supports_text_to_image: settings.supports_text_to_image,
    supports_image_to_image: settings.supports_image_to_image,
    supports_async_task: settings.supports_async_task,
  };
}

async function updateImageGenerationConfig(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const channelAction = body.channel_action ?? body.channelAction;
    if (channelAction === 'save-model-api') {
      const result = await saveImageModelApiForm(body, admin.id);
      return NextResponse.json({ ok: true, ...result }, { headers: privateHeaders });
    }
    if (channelAction === 'update-legacy-model-api') {
      const input = body.channel && typeof body.channel === 'object' && !Array.isArray(body.channel) ? body.channel as Record<string, unknown> : body;
      const channel = await updateLegacyImageGenerationModelApi(input, admin.id);
      return NextResponse.json({ ok: true, channel });
    }
    if (channelAction === 'set-model-default') {
      if (typeof body.model !== 'string' || !IMAGE_STUDIO_MODELS.includes(body.model as ImageStudioModel)) {
        return NextResponse.json({ error: '所选图片型号不在允许列表中' }, { status: 400 });
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'channelId')
        || (body.channelId !== null && typeof body.channelId !== 'string')) {
        return NextResponse.json({ error: '请重新选择默认供应商后保存' }, { status: 400 });
      }
      if (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
        return NextResponse.json({ error: '设置版本无效，请重新读取后保存' }, { status: 400 });
      }
      const defaultRoutes = await setImageGenerationModelDefaultRoute(
        body.model as ImageStudioModel,
        body.channelId as ImageGenerationChannelId | null,
        body.expectedRevision,
        admin.id,
      );
      return NextResponse.json({ ok: true, defaultRoutes });
    }
    if (channelAction === 'create' || channelAction === 'update' || channelAction === 'archive' || channelAction === 'restore') {
      const input = body.channel && typeof body.channel === 'object' && !Array.isArray(body.channel)
        ? body.channel as Record<string, unknown>
        : body;
      const saved = channelAction === 'create'
        ? await createManagedImageGenerationChannel(input, admin.id)
        : channelAction === 'update'
          ? await updateManagedImageGenerationChannel(input, admin.id)
          : channelAction === 'archive'
            ? await archiveManagedImageGenerationChannel(input, admin.id)
            : await restoreManagedImageGenerationChannel(input, admin.id);
      return NextResponse.json({ ok: true, channel: saved });
    }
    const current = await getImageGenerationApiSettings();
    const candidate = buildImageGenerationApiSettingsPatch(current, body);

    if (candidate.enabled && !candidate.base_url) {
      return NextResponse.json({ error: '启用图形生成 API 前必须设置 API 地址' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.default_model) {
      return NextResponse.json({ error: '启用图形生成 API 前必须设置默认模型' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.api_key && !await hasLegacyImageGenerationModelApiKey('shared')) {
      return NextResponse.json({ error: '启用前请设置共用 API Key 或至少一个型号的独立 API Key' }, { status: 400 });
    }

    const saved = await saveImageGenerationApiSettings(body, admin.id);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'image_generation_api_config_update',
        target_type: 'PlatformSetting',
        target_id: IMAGE_GENERATION_API_SETTING_KEY,
        detail: JSON.stringify({
          enabled: saved.enabled,
          provider: saved.provider,
          base_url: saved.base_url,
          default_model: saved.default_model,
          timeout_ms: saved.timeout_ms,
          max_outputs_per_request: saved.max_outputs_per_request,
          default_ratio: saved.default_ratio,
          default_size: saved.default_size,
          output_format: saved.output_format,
          response_format: saved.response_format,
          watermark: saved.watermark,
          api_key_configured: Boolean(saved.api_key),
          api_key_changed: typeof body.api_key === 'string' && Boolean(body.api_key.trim()),
          api_key_cleared: body.clear_api_key === true,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: IMAGE_GENERATION_API_SETTING_KEY,
      config: safeConfigDto(saved),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('图形生成 API 地址')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ImageGenerationChannelError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof ImageGenerationDefaultRoutesError) {
      console.error('[Admin/ImageGenerationIntegration] Default routes are invalid');
      return NextResponse.json({ error: '图片型号默认供应商设置无法读取；未按空设置处理' }, { status: 500 });
    }
    console.error('[Admin/ImageGenerationIntegration] Update failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({
      error: '保存图形生成 API 配置失败，请稍后重试；未确认保存成功',
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const mutationId = request.nextUrl.searchParams.get('mutation_id');
    if (mutationId !== null) {
      const result = await readImageModelApiSaveReceipt(admin.id, mutationId);
      return NextResponse.json({ ok: true, found: Boolean(result), receipt: result?.receipt || null }, { headers: privateHeaders });
    }
    if (request.nextUrl.searchParams.get('view') === 'model-api') {
      const result = await prisma.$transaction(async tx => ({ forms: await getImageModelApiForms(tx), defaultRoutes: await getImageGenerationDefaultRoutes(tx) }));
      return NextResponse.json({ ok: true, ...result }, { headers: privateHeaders });
    }
    const settings = await getImageGenerationApiSettings();
    const [channels, imageChannels, managedChannelPresets] = await Promise.all([
      getManagedImageGenerationChannels(),
      getImageGenerationChannelOptions(),
      getManagedChannelPresets(),
    ]);
    const defaultRoutes = imageChannels.defaultRoutes;
    return NextResponse.json({
      ok: true,
      setting_key: IMAGE_GENERATION_API_SETTING_KEY,
      config: safeConfigDto(settings),
      channels,
      options: imageChannels,
      imageChannels,
      defaultRoutes,
      managedChannelPresets,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ImageGenerationChannelError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof ImageGenerationDefaultRoutesError) {
      console.error('[Admin/ImageGenerationIntegration] Default routes are invalid');
      return NextResponse.json({ error: '图片型号默认供应商设置无法读取；未按空设置处理' }, { status: 500 });
    }
    console.error('[Admin/ImageGenerationIntegration] GET failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: '读取图形生成 API 配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  return updateImageGenerationConfig(request);
}

export async function POST(request: NextRequest) {
  return updateImageGenerationConfig(request);
}

export async function DELETE(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const input = body.channel && typeof body.channel === 'object' && !Array.isArray(body.channel)
      ? body.channel as Record<string, unknown>
      : body;
    const archived = await archiveManagedImageGenerationChannel(input, admin.id);
    return NextResponse.json({ ok: true, channel: archived });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ImageGenerationChannelError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[Admin/ImageGenerationIntegration] Delete failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: '归档图片供应商配置失败' }, { status: 500 });
  }
}
