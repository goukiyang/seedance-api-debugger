import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  MUSK_API_SETTING_KEY,
  buildMuskApiSettingsPatch,
  MuskApiError,
  createMuskChatCompletion,
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

export async function POST(request: NextRequest) {
  let adminId: string | null = null;
  const startedAt = Date.now();

  try {
    const admin = await getAdminUser(request);
    adminId = admin.id;
    const settings = await getMuskApiSettings();

    if (!isMuskApiReady(settings)) {
      return NextResponse.json({
        error: 'Musk API 未启用或缺少 API Key，请先保存完整配置后再测试',
        config: safeConfigDto(settings),
      }, { status: 400 });
    }

    const completion = await createMuskChatCompletion({
      settings,
      timeoutMs: 20000,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是 API 连通性测试助手。只能输出 JSON 对象，不要输出解释。',
        },
        {
          role: 'user',
          content: '返回 {"ok": true, "purpose": "musk_connection_test"}',
        },
      ],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.content);
    } catch {
      throw new MuskApiError('Musk API 连通成功，但返回内容不是可解析 JSON', 502, 'musk_api_test_invalid_json');
    }

    const jsonOk = Boolean(parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true);
    if (!jsonOk) {
      throw new MuskApiError('Musk API 连通成功，但测试 JSON 内容不符合预期', 502, 'musk_api_test_unexpected_json');
    }

    const latencyMs = Date.now() - startedAt;
    const testedAt = new Date().toISOString();

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'musk_api_config_test',
        target_type: 'PlatformSetting',
        target_id: MUSK_API_SETTING_KEY,
        detail: JSON.stringify({
          status: 'success',
          model: completion.model || settings.default_model,
          latency_ms: latencyMs,
          tested_at: testedAt,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      config: safeConfigDto(settings),
      test: {
        status: 'passed',
        model: completion.model || settings.default_model,
        latency_ms: latencyMs,
        json_ok: true,
        tested_at: testedAt,
      },
    });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;

    if (adminId) {
      try {
        await prisma.operationLog.create({
          data: {
            operator_id: adminId,
            action: 'musk_api_config_test',
            target_type: 'PlatformSetting',
            target_id: MUSK_API_SETTING_KEY,
            detail: JSON.stringify({
              status: 'failed',
              latency_ms: latencyMs,
              error: error instanceof Error ? error.message : 'Musk API 测试失败',
            }),
          },
        });
      } catch (logError) {
        console.error('[Admin/MuskIntegration] POST log failed:', logError);
      }
    }

    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof MuskApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[Admin/MuskIntegration] POST failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Musk API 测试失败',
    }, { status: 500 });
  }
}
