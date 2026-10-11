import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
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
  ImageGenerationChannelError,
} from '@/lib/integrations/image-generation';

export const dynamic = 'force-dynamic';

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
    if (candidate.enabled && !candidate.api_key) {
      return NextResponse.json({ error: '启用图形生成 API 前必须设置 API Key' }, { status: 400 });
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
    console.error('[Admin/ImageGenerationIntegration] Update failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({
      error: '保存图形生成 API 配置失败，请稍后重试；未确认保存成功',
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getImageGenerationApiSettings();
    const [channels, options] = await Promise.all([
      getManagedImageGenerationChannels(),
      getImageGenerationChannelOptions(),
    ]);
    return NextResponse.json({
      ok: true,
      setting_key: IMAGE_GENERATION_API_SETTING_KEY,
      config: safeConfigDto(settings),
      channels,
      options,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ImageGenerationChannelError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
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
