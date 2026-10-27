import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { parseRoleTextPolicy, ROLE_TEXT_RISK_NOTICE_VERSION, type RoleTextPolicy } from '@/lib/canvas-roles/text-billing';
import { TEXT_BILLING_KEY, textScope } from '@/lib/canvas-roles/text-provider';
import { record, RoleError } from '@/lib/canvas-roles/types';
import { assertCurrentRoleUser, assertRoleCollaborationWritable } from '@/lib/canvas-roles/permissions';
import { isStudioTextModel } from '@/lib/template-studio/text-models';
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
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function policyEnvelope(raw: string | null | undefined): Record<string, unknown> {
  if (raw == null) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RoleError('角色文字设置损坏，未覆盖原合同', 409, 'text_policy_invalid'); }
  if (!record(value)) throw new RoleError('角色文字设置格式无效，未覆盖原合同', 409, 'text_policy_invalid');
  return value;
}

function safePolicyDto(value: Record<string, unknown>, settings: Awaited<ReturnType<typeof getMuskApiSettings>>) {
  const policy = parseRoleTextPolicy(value.policy, textScope(settings));
  const stored = record(value.policy) ? value.policy : null;
  const revision = stored && Number.isSafeInteger(stored.revision) && Number(stored.revision) >= 0 ? Number(stored.revision) : 0;
  return { revision, enabled: policy?.enabled === true, allowUnpricedText: policy?.allowUnpricedText === true,
    allowedModels: policy?.allowedModels || [settings.default_model].filter(isStudioTextModel),
    maxInputBytes: policy?.maxInputBytes || 32768, maxOutputTokens: policy?.maxOutputTokens || 2048,
    consentValid: Boolean(policy?.consent), needsConsent: !policy || !policy.consent,
    pointsPerUsd: 35, riskNoticeVersion: ROLE_TEXT_RISK_NOTICE_VERSION };
}

async function saveRoleTextPolicy(body: Record<string, unknown>, admin: SessionUser) {
  assertRoleCollaborationWritable();
  const actorId = admin.id;
  if (Object.keys(body).some(key => !['role_text_policy', 'base_revision'].includes(key)) || !record(body.role_text_policy)) {
    throw new RoleError('角色文字设置只能单独保存');
  }
  const input = body.role_text_policy;
  if (Object.keys(input).some(key => !['enabled', 'allowedModels', 'allowUnpricedText', 'maxInputBytes', 'maxOutputTokens', 'riskAcknowledged'].includes(key))
    || typeof input.enabled !== 'boolean' || typeof input.allowUnpricedText !== 'boolean'
    || !Array.isArray(input.allowedModels) || !input.allowedModels.length || input.allowedModels.length > 20
    || input.allowedModels.some(model => !isStudioTextModel(model)) || new Set(input.allowedModels).size !== input.allowedModels.length
    || !Number.isSafeInteger(input.maxInputBytes) || Number(input.maxInputBytes) < 1 || Number(input.maxInputBytes) > 131072
    || !Number.isSafeInteger(input.maxOutputTokens) || Number(input.maxOutputTokens) < 1 || Number(input.maxOutputTokens) > 4096
    || !Number.isSafeInteger(body.base_revision) || Number(body.base_revision) < 0
    || input.riskAcknowledged !== undefined && typeof input.riskAcknowledged !== 'boolean') throw new RoleError('请核对角色文字的模型、输入输出上限和设置版本');
  if (input.enabled && (!input.allowUnpricedText || input.riskAcknowledged !== true)) {
    throw new RoleError('启用前须明确确认无报价调用可能产生超出预留的供应商费用', 409, 'text_risk_consent_required');
  }
  return prisma.$transaction(async tx => {
    await assertCurrentRoleUser(tx, admin);
    const row = await tx.platformSetting.findUnique({ where: { key: TEXT_BILLING_KEY } });
    const value = policyEnvelope(row?.value_json);
    const settings = await getMuskApiSettings(tx);
    const dto = safePolicyDto(value, settings);
    if (dto.revision !== body.base_revision || dto.revision >= 1_000_000_000) throw new RoleError('角色文字设置已变化，请保留输入并重新读取', 409, 'text_policy_revision_conflict');
    if (input.enabled && (!settings.enabled || !settings.api_key || new URL(settings.base_url).origin !== 'https://api.muskapis.com')) {
      throw new RoleError('请先保存可用的原Musk文字设置；角色开关不代替主配置', 409, 'text_provider_unavailable');
    }
    const policy: RoleTextPolicy = { version: 'role-text-policy.v2', enabled: input.enabled === true,
      scope: textScope(settings), allowedModels: input.allowedModels as string[], allowUnpricedText: input.allowUnpricedText === true,
      maxInputBytes: Number(input.maxInputBytes), maxOutputTokens: Number(input.maxOutputTokens), revision: dto.revision + 1,
      consent: input.enabled ? { actorId, at: new Date().toISOString(), riskNoticeVersion: ROLE_TEXT_RISK_NOTICE_VERSION } : null };
    // Keep all historical v1 contracts and unrelated envelope fields intact.
    const valueJson = JSON.stringify({ ...value, policy });
    if (row) {
      const saved = await tx.platformSetting.updateMany({ where: { key: TEXT_BILLING_KEY, value_json: row.value_json },
        data: { value_json: valueJson, updated_by: actorId } });
      if (saved.count !== 1) throw new RoleError('角色文字设置发生冲突，原合同未改', 409, 'text_policy_revision_conflict');
    } else await tx.platformSetting.create({ data: { key: TEXT_BILLING_KEY, value_json: valueJson, updated_by: actorId } });
    await tx.operationLog.create({ data: { operator_id: actorId, action: 'role_text_policy_update', target_type: 'PlatformSetting',
      target_id: TEXT_BILLING_KEY, detail: JSON.stringify({ revision: policy.revision, enabled: policy.enabled,
        allowedModels: policy.allowedModels, maxInputBytes: policy.maxInputBytes, maxOutputTokens: policy.maxOutputTokens,
        allowUnpricedText: policy.allowUnpricedText, riskNoticeVersion: policy.consent?.riskNoticeVersion || null }) } });
    return safePolicyDto({ policy }, settings);
  });
}

function safeConfigDto(settings: Awaited<ReturnType<typeof getMuskApiSettings>>) {
  return {
    enabled: settings.enabled,
    ready: isMuskApiReady(settings),
    base_url: settings.base_url,
    default_model: settings.default_model,
    api_key_configured: Boolean(settings.api_key),
  };
}

export const GET = apiRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getMuskApiSettings();
    const policyRow = await prisma.platformSetting.findUnique({ where: { key: TEXT_BILLING_KEY }, select: { value_json: true } });
    let rolePolicy: ReturnType<typeof safePolicyDto> | null = null;
    let rolePolicyError: string | null = null;
    try { rolePolicy = safePolicyDto(policyEnvelope(policyRow?.value_json), settings); }
    catch { rolePolicyError = '角色文字设置无法读取，原文字配置仍可单独使用；未覆盖旧合同。'; }
    return NextResponse.json({
      ok: true,
      setting_key: MUSK_API_SETTING_KEY,
      config: safeConfigDto(settings),
      role_text_policy: rolePolicy,
      role_text_policy_error: rolePolicyError,
    }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Admin/MuskIntegration] GET failed:', error);
    return NextResponse.json({ error: '读取 Musk API 配置失败' }, { status: 500 });
  }
});

export const PUT = apiRoute({ access: 'admin', rateLimit: false }, async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(body, 'role_text_policy')) {
      return NextResponse.json({ ok: true, role_text_policy: await saveRoleTextPolicy(body, admin) }, { headers: privateHeaders });
    }
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
      return NextResponse.json({ error: error.message, ...(error instanceof RoleError ? { code: error.code } : {}) }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('Musk API 地址')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return apiErrorResponse(error);
  }
});

export const POST = apiRoute({ access: 'admin', rateLimit: false }, async function POST(request: NextRequest) {
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

    return apiErrorResponse(error);
  }
});
