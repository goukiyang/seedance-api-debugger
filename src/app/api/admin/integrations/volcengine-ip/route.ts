import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  VOLCENGINE_IP_API_SETTING_KEY,
  buildVolcengineIpApiSettingsPatch,
  getVolcengineIpApiSettings,
  safeVolcengineIpConfigDto,
  saveVolcengineIpApiSettings,
} from '@/lib/integrations/volcengine-ip';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getVolcengineIpApiSettings();
    return NextResponse.json({
      ok: true,
      setting_key: VOLCENGINE_IP_API_SETTING_KEY,
      config: safeVolcengineIpConfigDto(settings),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/VolcengineIpIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取火山 IP 生成配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const current = await getVolcengineIpApiSettings();
    const candidate = buildVolcengineIpApiSettingsPatch(current, body);

    if (candidate.enabled && !candidate.base_url) {
      return NextResponse.json({ error: '启用火山 IP 生成前必须设置 API 地址' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.default_model) {
      return NextResponse.json({ error: '启用火山 IP 生成前必须设置 Model ID' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.api_key) {
      return NextResponse.json({ error: '启用火山 IP 生成前必须设置 API Key' }, { status: 400 });
    }

    const saved = await saveVolcengineIpApiSettings(body, admin.id);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'volcengine_ip_api_config_update',
        target_type: 'PlatformSetting',
        target_id: VOLCENGINE_IP_API_SETTING_KEY,
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
      setting_key: VOLCENGINE_IP_API_SETTING_KEY,
      config: safeVolcengineIpConfigDto(saved),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('火山 API 地址')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Admin/VolcengineIpIntegration] PUT failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : '保存火山 IP 生成配置失败',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return PUT(request);
}
