import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);
    const body = await request.json() as Record<string, unknown>;
    const templateId = cleanString(body.template_id);
    const agentRunId = cleanString(body.agent_run_id) || null;
    const reason = cleanString(body.reason, '管理员拒绝模块草稿');

    if (!templateId) return NextResponse.json({ error: '请选择模板' }, { status: 400 });

    await prisma.$transaction(async (tx) => {
      const template = await tx.generationTemplate.findFirst({
        where: { id: templateId, status: { in: ['draft', 'active'] } },
        select: { id: true },
      });
      if (!template) throw new Error('TEMPLATE_NOT_FOUND');

      if (agentRunId) {
        await tx.agentRun.updateMany({
          where: { id: agentRunId, template_id: template.id },
          data: {
            status: 'failed',
            completed_at: new Date(),
            error_message: reason.slice(0, 1000),
            user_edited: true,
          },
        });
      }

      await tx.templateMemory.create({
        data: {
          template_id: template.id,
          user_id: user!.id,
          agent_run_id: agentRunId,
          memory_type: 'note',
          signal: 'negative',
          summary: `拒绝模块草稿：${reason.slice(0, 80)}`,
          metadata_json: JSON.stringify({
            kind: 'module_builder_reject',
            reason,
          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'module_builder_reject',
          target_type: 'GenerationTemplate',
          target_id: template.id,
          detail: JSON.stringify({ agent_run_id: agentRunId, reason }),
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: '模板不存在或不可用' }, { status: 404 });
    }
    console.error('[ModuleBuilder] Reject failed:', error);
    return NextResponse.json({ error: '拒绝模块草稿失败' }, { status: 500 });
  }
}
