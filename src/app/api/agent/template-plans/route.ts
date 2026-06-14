import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import type { AgentPlan } from '@/lib/agent-plans/template-plans';
import { createTemplatePlanResult, normalizeTemplateUserInput } from '@/lib/agent-plans/template-plans';
import { serializeGenerationTemplate, TEMPLATE_INCLUDE } from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

function pickMemoryPreferredPlanKey(memories: Array<{ summary: string | null; metadata_json: string | null }>): AgentPlan['key'] | null {
  const scores = new Map<AgentPlan['key'], number>();
  for (const memory of memories) {
    const fromSummary = memory.summary?.match(/方案\s*([A-D])/i)?.[1]?.toUpperCase();
    let fromMetadata: unknown = null;
    if (memory.metadata_json) {
      try {
        fromMetadata = JSON.parse(memory.metadata_json);
      } catch {
        fromMetadata = null;
      }
    }
    const metadataKey = fromMetadata && typeof fromMetadata === 'object'
      ? (fromMetadata as Record<string, unknown>).planKey
      : null;
    const key = typeof metadataKey === 'string' ? metadataKey.toUpperCase() : fromSummary;
    if (key === 'A' || key === 'B' || key === 'C' || key === 'D') {
      scores.set(key, (scores.get(key) || 0) + 1);
    }
  }
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const templateId = typeof body.template_id === 'string' && body.template_id.trim() ? body.template_id.trim() : null;
    if (!templateId) return NextResponse.json({ error: '请选择模板' }, { status: 400 });

    const input = normalizeTemplateUserInput(body.input || body);
    if (!input.text) return NextResponse.json({ error: '请填写本次视频需求' }, { status: 400 });

    const templateRecord = await prisma.generationTemplate.findFirst({
      where: {
        id: templateId,
        OR: user.role === 'admin' ? [{ status: { in: ['draft', 'active'] } }] : [{ status: 'active' }],
      },
      include: TEMPLATE_INCLUDE,
    });
    if (!templateRecord) return NextResponse.json({ error: '模板不存在或不可用' }, { status: 404 });

    const template = serializeGenerationTemplate(templateRecord);
    const result = createTemplatePlanResult(template, input);
    const videoCardId = typeof body.video_card_id === 'string' && body.video_card_id.trim() ? body.video_card_id.trim() : null;
    const memories = await prisma.templateMemory.findMany({
      where: {
        template_id: template.id,
        user_id: user.id,
        memory_type: 'plan_selected',
        signal: 'positive',
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { summary: true, metadata_json: true },
    });
    const memoryPreferredPlanKey = input.modifiers.length === 0 ? pickMemoryPreferredPlanKey(memories) : null;
    const recommendedPlanKey = memoryPreferredPlanKey || result.recommendedPlanKey;
    const recommendedPrompt = result.plans.find((plan) => plan.key === recommendedPlanKey)?.prompt || result.prompt;

    const agentRun = await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.create({
        data: {
          template_id: template.id,
          user_id: user.id,
          video_card_id: videoCardId,
          status: 'planned',
          user_input_json: JSON.stringify(input),
          modifiers_json: JSON.stringify(input.modifiers),
          plans_json: JSON.stringify(result.plans),
          selected_plan_key: recommendedPlanKey,
          agent_prompt_snapshot: recommendedPrompt,
          final_prompt_snapshot: recommendedPrompt,
          steps: {
            create: [
              {
                step_key: 'intent_parse',
                title: 'Intent 解析',
                input_json: JSON.stringify({ text: input.text, modifiers: input.modifiers }),
                output_json: JSON.stringify({ intent: input.text, modifiers: input.modifiers }),
                sort_order: 1,
              },
              {
                step_key: 'template_load',
                title: '模板加载',
                input_json: JSON.stringify({ template_id: template.id }),
                output_json: JSON.stringify({ template_key: template.template_key, modules: template.module_bindings }),
                sort_order: 2,
              },
              {
                step_key: 'rule_compute',
                title: '规则计算',
                input_json: JSON.stringify({ rules: template.rules }),
                output_json: JSON.stringify({
                  must: template.rules.filter((rule) => rule.rule_type === 'must').length,
                  forbid: template.rules.filter((rule) => rule.rule_type === 'forbid').length,
                  suggest: template.rules.filter((rule) => rule.rule_type === 'suggest').length,
                }),
                sort_order: 3,
              },
              {
                step_key: 'plan_generate',
                title: '方案生成',
                input_json: JSON.stringify({ template: template.template_key, input }),
                output_json: JSON.stringify({ plans: result.plans, recommendedPlanKey: result.recommendedPlanKey }),
                sort_order: 4,
              },
              {
                step_key: 'memory_apply',
                title: 'Memory 推荐',
                input_json: JSON.stringify({ recentPositivePlanSelections: memories.length }),
                output_json: JSON.stringify({ memoryPreferredPlanKey, finalRecommendedPlanKey: recommendedPlanKey }),
                sort_order: 5,
              },
              {
                step_key: 'prompt_compose',
                title: 'Prompt 生成',
                input_json: JSON.stringify({ selectedPlan: recommendedPlanKey }),
                output_json: JSON.stringify({ prompt: recommendedPrompt }),
                sort_order: 6,
              },
            ],
          },
        },
        include: { steps: { orderBy: { sort_order: 'asc' } } },
      });

      await tx.templateMemory.create({
        data: {
          template_id: template.id,
          user_id: user.id,
          agent_run_id: run.id,
          memory_type: 'note',
          signal: 'neutral',
          summary: `生成了 ${result.plans.length} 个候选方案，推荐 ${recommendedPlanKey}`,
          metadata_json: JSON.stringify({ modifiers: input.modifiers, memoryPreferredPlanKey }),
        },
      });

      return run;
    });

    return NextResponse.json({
      agent_run_id: agentRun.id,
      template,
      plans: result.plans,
      recommended_plan_key: recommendedPlanKey,
      memory_preferred_plan_key: memoryPreferredPlanKey,
      prompt: recommendedPrompt,
      steps: agentRun.steps,
    });
  } catch (error) {
    console.error('[TemplatePlans] Generate error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
