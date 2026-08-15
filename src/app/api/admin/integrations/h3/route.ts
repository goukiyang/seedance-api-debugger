import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  H3_API_SETTING_KEY,
  buildH3ApiSettingsPatch,
  getH3ApiSettings,
  safeH3ConfigDto,
  saveH3ApiSettings,
} from '@/lib/integrations/h3';
import { getH3Health, listH3Presets } from '@/lib/provider/h3';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getH3ApiSettings();
    return NextResponse.json({
      ok: true,
      setting_key: H3_API_SETTING_KEY,
      config: safeH3ConfigDto(settings),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/H3Integration] GET failed:', error);
    return NextResponse.json({ error: '读取 H3 配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const current = await getH3ApiSettings();
    const candidate = buildH3ApiSettingsPatch(current, body);

    if (candidate.enabled && !candidate.base_url) {
      return NextResponse.json({ error: '启用 H3 前必须设置 API 地址' }, { status: 400 });
    }
    if (candidate.enabled && !candidate.api_token) {
      return NextResponse.json({ error: '启用 H3 前必须设置用户 token' }, { status: 400 });
    }

    const saved = await saveH3ApiSettings(body, admin.id);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'h3_api_config_update',
        target_type: 'PlatformSetting',
        target_id: H3_API_SETTING_KEY,
        detail: JSON.stringify({
          enabled: saved.enabled,
          base_url: saved.base_url,
          default_preset_id: saved.default_preset_id,
          api_token_configured: Boolean(saved.api_token),
          admin_token_configured: Boolean(saved.admin_token),
          api_token_changed: typeof body.api_token === 'string' && Boolean(body.api_token.trim()),
          admin_token_changed: typeof body.admin_token === 'string' && Boolean(body.admin_token.trim()),
          api_token_cleared: body.clear_api_token === true,
          admin_token_cleared: body.clear_admin_token === true,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: H3_API_SETTING_KEY,
      config: safeH3ConfigDto(saved),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && (error.message.startsWith('H3 API 地址') || error.message.startsWith('H3 preset'))) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Admin/H3Integration] PUT failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : '保存 H3 配置失败',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const settings = await getH3ApiSettings();
    const health = await getH3Health({ baseUrl: settings.base_url });
    const presets = settings.api_token
      ? await listH3Presets({ baseUrl: settings.base_url, apiToken: settings.api_token })
      : null;

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'h3_api_connection_test',
        target_type: 'PlatformSetting',
        target_id: H3_API_SETTING_KEY,
        detail: JSON.stringify({
          base_url: settings.base_url,
          api_token_configured: Boolean(settings.api_token),
          admin_token_configured: Boolean(settings.admin_token),
          health_api: typeof health === 'object' && health ? (health as Record<string, unknown>).api : null,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: H3_API_SETTING_KEY,
      config: safeH3ConfigDto(settings),
      test: { health, presets, tested_at: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/H3Integration] POST failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'H3 连接测试失败',
    }, { status: 500 });
  }
}
