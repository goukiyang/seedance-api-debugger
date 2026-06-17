import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  CODEX_VIDEO_API_SETTING_KEY,
  buildCodexVideoApiSettingsPatch,
  getCodexVideoApiSettings,
  resolveCodexLinkedUser,
  saveCodexVideoApiSettings,
} from '@/lib/integrations/codex';

export const dynamic = 'force-dynamic';

function safeConfigDto(settings: Awaited<ReturnType<typeof getCodexVideoApiSettings>>, linkedUser: Awaited<ReturnType<typeof resolveCodexLinkedUser>>) {
  return {
    enabled: settings.enabled,
    ready: settings.enabled && Boolean(settings.token_hash) && Boolean(linkedUser && linkedUser.status === 'active'),
    source_label: settings.source_label,
    user_selector: settings.user_selector,
    token_configured: Boolean(settings.token_hash),
    token_preview: settings.token_preview,
    linked_user: linkedUser ? {
      id: linkedUser.id,
      name: linkedUser.name,
      username: linkedUser.username,
      email: linkedUser.email,
      avatar_url: linkedUser.avatar_url,
      account_type: linkedUser.account_type,
      role: linkedUser.role,
      status: linkedUser.status,
    } : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getCodexVideoApiSettings();
    const linkedUser = await resolveCodexLinkedUser(settings);
    return NextResponse.json({
      ok: true,
      setting_key: CODEX_VIDEO_API_SETTING_KEY,
      config: safeConfigDto(settings, linkedUser),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/CodexIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取 Codex 接口配置失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const current = await getCodexVideoApiSettings();
    const candidate = buildCodexVideoApiSettingsPatch(current, body);
    const linkedUser = await resolveCodexLinkedUser(candidate.settings);

    if (candidate.settings.enabled && !candidate.settings.token_hash) {
      return NextResponse.json({ error: '启用 Codex 接口前必须设置 token' }, { status: 400 });
    }
    if (candidate.settings.enabled && !linkedUser) {
      return NextResponse.json({ error: '启用 Codex 接口前必须绑定一个存在的用户' }, { status: 400 });
    }
    if (candidate.settings.enabled && linkedUser?.status !== 'active') {
      return NextResponse.json({ error: '绑定用户不是 active 状态，不能启用 Codex 接口' }, { status: 400 });
    }

    const saved = await saveCodexVideoApiSettings(body, admin.id);
    const savedLinkedUser = await resolveCodexLinkedUser(saved.settings);

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'codex_api_config_update',
        target_type: 'PlatformSetting',
        target_id: CODEX_VIDEO_API_SETTING_KEY,
        detail: JSON.stringify({
          enabled: saved.settings.enabled,
          source_label: saved.settings.source_label,
          user_selector: saved.settings.user_selector,
          token_changed: saved.token_changed,
          token_cleared: saved.token_cleared,
          token_configured: Boolean(saved.settings.token_hash),
          linked_user_id: savedLinkedUser?.id || null,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      setting_key: CODEX_VIDEO_API_SETTING_KEY,
      config: safeConfigDto(saved.settings, savedLinkedUser),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/CodexIntegration] PUT failed:', error);
    return NextResponse.json({ error: '保存 Codex 接口配置失败' }, { status: 500 });
  }
}
