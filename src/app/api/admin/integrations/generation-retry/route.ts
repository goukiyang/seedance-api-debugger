import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { retryConfig } from '@/lib/generation-retry/store';
import { RETRY_CONFIG_KEY, RETRY_RULES } from '@/lib/generation-retry/contracts';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const config = await retryConfig();
    return NextResponse.json({ revision: config.revision, enabledIds: config.enabledIds, maxRetries: 3, rules: RETRY_RULES }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return NextResponse.json({ error: '读取重试规则失败' }, { status: error instanceof AuthError ? error.status : 503 }); }
}
export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request), body = await request.json();
    if (typeof body.revision !== 'string' || !Array.isArray(body.enabledIds)
      || body.enabledIds.some((id: unknown) => typeof id !== 'string' || !RETRY_RULES.some(rule => rule.id === id))) {
      return NextResponse.json({ error: '只能启用已核实的精确规则' }, { status: 400 });
    }
    const result = await prisma.$transaction(async tx => {
      const config = await retryConfig(tx);
      if (config.revision !== body.revision) throw new Error('conflict');
      const value = { revision: randomUUID(), enabledIds: Array.from(new Set(body.enabledIds as string[])) };
      if (config.row) {
        const changed = await tx.platformSetting.updateMany({ where: { key: RETRY_CONFIG_KEY, value_json: config.row.value_json },
          data: { value_json: JSON.stringify(value), updated_by: admin.id } });
        if (!changed.count) throw new Error('conflict');
      } else await tx.platformSetting.create({ data: { key: RETRY_CONFIG_KEY, value_json: JSON.stringify(value), updated_by: admin.id } });
      await tx.operationLog.create({ data: { operator_id: admin.id, action: 'safe_retry_rules_update', target_type: 'PlatformSetting',
        target_id: RETRY_CONFIG_KEY, detail: JSON.stringify(value) } });
      return value;
    });
    return NextResponse.json(result);
  } catch (error) { return NextResponse.json({ error: '规则未保存，请刷新当前版本后重试' }, { status: error instanceof AuthError ? error.status : 409 }); }
}
