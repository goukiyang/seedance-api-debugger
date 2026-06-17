import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import {
  getModuleBuilderRules,
  saveModuleBuilderRules,
} from '@/lib/templates/module-builder-rules';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function GET() {
  const user = await getSession();
  try {
    requireAdmin(user);
    const rules = await getModuleBuilderRules();
    return NextResponse.json({ rules });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ModuleBuilder] Load rules failed:', error);
    return NextResponse.json({ error: '读取模块生成规则失败' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);
    const body = await request.json() as Record<string, unknown>;
    const rules = cleanString(body.rules);
    if (!rules) return NextResponse.json({ error: '规则不能为空' }, { status: 400 });

    const saved = await saveModuleBuilderRules(rules, user!.id);
    await prisma.operationLog.create({
      data: {
        operator_id: user!.id,
        action: 'module_builder_rules_update',
        target_type: 'PlatformSetting',
        target_id: 'module_builder_default_rules_v1',
        detail: JSON.stringify({ rules_length: saved.length }),
      },
    });
    return NextResponse.json({ ok: true, rules: saved });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ModuleBuilder] Save rules failed:', error);
    return NextResponse.json({ error: '保存模块生成规则失败' }, { status: 500 });
  }
}
