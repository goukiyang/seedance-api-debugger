import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  AIMEDIAKIT_API_SETTING_KEY,
  buildAiMediaKitApiSettingsPatch,
  getAiMediaKitApiSettings,
  safeAiMediaKitConfigDto,
  saveAiMediaKitApiSettings,
} from '@/lib/integrations/aimediakit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getAiMediaKitApiSettings();
    return NextResponse.json({
      ok: true,
      setting_key: AIMEDIAKIT_API_SETTING_KEY,
      config: safeAiMediaKitConfigDto(settings),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/AiMediaKitIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取 AI MediaKit 配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const current = await getAiMediaKitApiSettings();
    const candidate = buildAiMediaKitApiSettingsPatch(current, body);

    if (candidate.enabled && !candidate.base_url) {
      return NextResponse.json({ error: '启用 AI MediaKit 前必须设置 API 地址' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.api_key) {
      return NextResponse.json({ error: '启用 AI MediaKit 前必须设置 API Key' }, { status: 400 });
    }

    const saved = await saveAiMediaKitApiSettings(body, admin.id);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'aimediakit_api_config_update',
        target_type: 'PlatformSetting',
        target_id: AIMEDIAKIT_API_SETTING_KEY,
        detail: JSON.stringify({
          enabled: saved.enabled,
          base_url: saved.base_url,
          api_key_configured: Boolean(saved.api_key),
          api_key_changed: typeof body.api_key === 'string' && Boolean(body.api_key.trim()),
          api_key_cleared: body.clear_api_key === true,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: AIMEDIAKIT_API_SETTING_KEY,
      config: safeAiMediaKitConfigDto(saved),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('AI MediaKit API 地址')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Admin/AiMediaKitIntegration] PUT failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : '保存 AI MediaKit 配置失败',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return PUT(request);
}
