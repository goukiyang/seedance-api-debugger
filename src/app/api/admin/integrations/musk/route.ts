import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  MUSK_API_SETTING_KEY,
  buildMuskApiSettingsPatch,
  getMuskApiSettings,
  isMuskApiReady,
  saveMuskApiSettings,
} from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

function safeConfigDto(settings: Awaited<ReturnType<typeof getMuskApiSettings>>) {
  return {
    enabled: settings.enabled,
    ready: isMuskApiReady(settings),
    base_url: settings.base_url,
    default_model: settings.default_model,
    api_key_configured: Boolean(settings.api_key),
  };
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getMuskApiSettings();
    return NextResponse.json({
      ok: true,
      setting_key: MUSK_API_SETTING_KEY,
      config: safeConfigDto(settings),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/MuskIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取 Musk API 配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const current = await getMuskApiSettings();
    const candidate = buildMuskApiSettingsPatch(current, body);

    if (candidate.enabled && !candidate.base_url) {
      return NextResponse.json({ error: '启用 Musk API 前必须设置 API 地址' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.default_model) {
      return NextResponse.json({ error: '启用 Musk API 前必须设置默认模型' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.api_key) {
      return NextResponse.json({ error: '启用 Musk API 前必须设置 API Key' }, { status: 400 });
    }

    const saved = await saveMuskApiSettings(body, admin.id);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'musk_api_config_update',
        target_type: 'PlatformSetting',
        target_id: MUSK_API_SETTING_KEY,
        detail: JSON.stringify({
          enabled: saved.enabled,
          base_url: saved.base_url,
          default_model: saved.default_model,
          api_key_configured: Boolean(saved.api_key),
          api_key_changed: typeof body.api_key === 'string' && Boolean(body.api_key.trim()),
          api_key_cleared: body.clear_api_key === true,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: MUSK_API_SETTING_KEY,
      config: safeConfigDto(saved),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('Musk API 地址')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Admin/MuskIntegration] PUT failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : '保存 Musk API 配置失败',
    }, { status: 500 });
  }
}
