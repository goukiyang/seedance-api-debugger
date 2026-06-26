import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import { getMuskApiSettings, isMuskApiReady, MuskApiError } from '@/lib/integrations/musk';
import {
  DEFAULT_TEMPLATE_CONFIG_RULES,
  generateTemplateConfigDraftWithLlm,
} from '@/lib/templates/template-config-builder';
import { serializeGenerationTemplate, TEMPLATE_INCLUDE } from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeContextAssetIds(value: unknown) {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim())
      .slice(0, 20)
    : [];
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);

    const body = await request.json() as Record<string, unknown>;
    const templateId = cleanString(body.template_id);
    const intent = cleanString(body.intent);
    const sessionRules = cleanString(body.session_rules, DEFAULT_TEMPLATE_CONFIG_RULES);
    const contextAssetIds = normalizeContextAssetIds(body.context_asset_ids);
    if (!intent) return NextResponse.json({ error: '请描述要创建或调整的模板' }, { status: 400 });

    const templateRecord = templateId
      ? await prisma.generationTemplate.findFirst({
        where: { id: templateId, status: { in: ['draft', 'active'] } },
        include: TEMPLATE_INCLUDE,
      })
      : null;
    if (templateId && !templateRecord) return NextResponse.json({ error: '模板不存在或不可用' }, { status: 404 });

    const template = templateRecord ? serializeGenerationTemplate(templateRecord) : null;
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) {
      await prisma.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'template_config_generate',
          target_type: template ? 'GenerationTemplate' : 'TemplateConfigAgent',
          target_id: template?.id || null,
          detail: JSON.stringify({ status: 'failed', reason: 'musk_api_not_configured' }),
        },
      });
      return NextResponse.json({ error: 'Musk API 未启用或缺少 API Key，请先到 API 设置完成配置' }, { status: 503 });
    }

    const input = { template, intent, sessionRules, contextAssetIds };
    const result = await generateTemplateConfigDraftWithLlm({ settings, input });
    const status = result.needsClarification
      ? 'draft'
      : result.validationErrors.length > 0 ? 'failed' : 'planned';
    const summary = result.needsClarification
      ? `Template Config 需要追问：${result.questions?.[0] || '缺少关键信息'}`
      : result.draft
        ? `Template Config 生成模板草稿：${result.draft.templateDraft.name}`
        : 'Template Config 未生成可保存草稿';

    let agentRunId: string | null = null;
    if (template) {
      const agentRun = await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.create({
          data: {
            template_id: template.id,
            user_id: user!.id,
            status,
            user_input_json: JSON.stringify({
              kind: 'template_config',
              intent,
              sessionRules,
              contextAssetIds,
            }),
            modifiers_json: JSON.stringify([]),
            plans_json: JSON.stringify({
              kind: 'template_config',
              needsClarification: result.needsClarification,
              questions: result.questions || [],
              draft: result.draft || null,
              validationErrors: result.validationErrors,
            }),
            selected_plan_key: result.draft?.templateDraft.name || null,
            agent_prompt_snapshot: JSON.stringify({ intent, sessionRules }).slice(0, 12000),
            final_prompt_snapshot: result.draft ? JSON.stringify(result.draft) : null,
            error_message: result.validationErrors.length > 0 ? result.validationErrors.join('；') : null,
            steps: {
              create: [
                {
                  step_key: 'template_config_context',
                  title: '模板上下文',
                  input_json: JSON.stringify({ template_id: template.id }),
                  output_json: JSON.stringify({
                    template_key: template.template_key,
                    modules: template.module_bindings,
                    promptCount: template.prompts.length,
                    ruleCount: template.rules.length,
                  }),
                  sort_order: 1,
                },
                {
                  step_key: 'template_config_rules',
                  title: '模板配置生成规则',
                  input_json: JSON.stringify({ defaultRules: DEFAULT_TEMPLATE_CONFIG_RULES, sessionRules }),
                  output_json: JSON.stringify({ contextAssetIds }),
                  sort_order: 2,
                },
                {
                  step_key: 'llm_generate',
                  title: 'LLM 生成模板配置草稿',
                  input_json: JSON.stringify({ provider: 'musk', model: settings.default_model }),
                  output_json: JSON.stringify({
                    model: result.model,
                    needsClarification: result.needsClarification,
                    questions: result.questions || [],
                    draft: result.draft || null,
                  }),
                  sort_order: 3,
                },
                {
                  step_key: 'validator',
                  title: '结构化校验',
                  input_json: JSON.stringify({ draft: result.draft || null }),
                  output_json: JSON.stringify({
                    valid: result.validationErrors.length === 0,
                    errors: result.validationErrors,
                  }),
                  sort_order: 4,
                },
                {
                  step_key: 'memory_record',
                  title: 'Memory 记录',
                  input_json: JSON.stringify({ summary }),
                  output_json: JSON.stringify({ status }),
                  sort_order: 5,
                },
              ],
            },
          },
        });

        await tx.templateMemory.create({
          data: {
            template_id: template.id,
            user_id: user!.id,
            agent_run_id: run.id,
            memory_type: 'note',
            signal: result.validationErrors.length > 0 ? 'negative' : 'neutral',
            summary,
            metadata_json: JSON.stringify({
              kind: 'template_config',
              needsClarification: result.needsClarification,
              validationErrors: result.validationErrors,
            }),
          },
        });

        return run;
      });
      agentRunId = agentRun.id;
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user!.id,
        action: 'template_config_generate',
        target_type: template ? 'GenerationTemplate' : 'TemplateConfigAgent',
        target_id: template?.id || null,
        detail: JSON.stringify({
          status,
          agent_run_id: agentRunId,
          needs_clarification: result.needsClarification,
          validation_errors: result.validationErrors.length,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      agent_run_id: agentRunId,
      needs_clarification: result.needsClarification,
      questions: result.questions || [],
      draft: result.draft || null,
      validation_errors: result.validationErrors,
      model: result.model,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof MuskApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof Error && error.message.startsWith('LLM ')) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error('[TemplateConfig] Generate failed:', error);
    return NextResponse.json({ error: '模板配置生成失败' }, { status: 500 });
  }
}
