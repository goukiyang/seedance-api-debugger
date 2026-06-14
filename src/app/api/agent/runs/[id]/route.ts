import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { serializeGenerationTemplate, TEMPLATE_INCLUDE } from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const run = await prisma.agentRun.findUnique({
      where: { id: params.id },
      include: {
        template: { include: TEMPLATE_INCLUDE },
        steps: { orderBy: { sort_order: 'asc' } },
      },
    });
    if (!run) return NextResponse.json({ error: '执行链路不存在' }, { status: 404 });
    if (user.role !== 'admin' && run.user_id !== user.id) {
      return NextResponse.json({ error: '权限不足' }, { status: 403 });
    }

    const memories = await prisma.templateMemory.findMany({
      where: { agent_run_id: run.id },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    return NextResponse.json({
      run: {
        id: run.id,
        template_id: run.template_id,
        user_id: run.user_id,
        video_task_id: run.video_task_id,
        video_card_id: run.video_card_id,
        status: run.status,
        user_input: safeJson(run.user_input_json, {}),
        modifiers: safeJson(run.modifiers_json, []),
        plans: safeJson(run.plans_json, []),
        selected_plan_key: run.selected_plan_key,
        agent_prompt_snapshot: run.agent_prompt_snapshot,
        final_prompt_snapshot: run.final_prompt_snapshot,
        user_edited: run.user_edited,
        error_message: run.error_message,
        created_at: run.created_at,
        updated_at: run.updated_at,
        completed_at: run.completed_at,
        template: serializeGenerationTemplate(run.template),
        steps: run.steps.map((step) => ({
          id: step.id,
          step_key: step.step_key,
          title: step.title,
          input: safeJson(step.input_json, null),
          output: safeJson(step.output_json, null),
          sort_order: step.sort_order,
          created_at: step.created_at,
        })),
        memories: memories.map((memory) => ({
          id: memory.id,
          memory_type: memory.memory_type,
          signal: memory.signal,
          summary: memory.summary,
          metadata: safeJson(memory.metadata_json, {}),
          created_at: memory.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('[AgentRuns] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

function safeJson(value: string | null, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
