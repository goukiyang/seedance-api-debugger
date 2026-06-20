import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import { getMuskApiSettings, isMuskApiReady, MuskApiError } from '@/lib/integrations/musk';
import {
  generateModuleBuilderDraftWithLlm,
  type ModuleBuilderType,
} from '@/lib/templates/module-builder';
import { getModuleBuilderRules } from '@/lib/templates/module-builder-rules';
import { serializeGenerationTemplate, TEMPLATE_INCLUDE } from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeModuleType(value: unknown): ModuleBuilderType {
  const raw = cleanString(value, 'auto');
  return [
    'auto',
    'character',
    'logo',
    'style',
    'camera',
    'rule',
    'asset_rule',
    'temporal',
    'prompt_format',
  ].includes(raw) ? raw as ModuleBuilderType : 'auto';
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
    const contextText = cleanString(body.context_text);
    const moduleType = normalizeModuleType(body.module_type);
    const defaultRules = await getModuleBuilderRules();
    const sessionRules = cleanString(body.session_rules, defaultRules);
    const contextAssetIds = normalizeContextAssetIds(body.context_asset_ids);

    if (!templateId) return NextResponse.json({ error: '请选择模板' }, { status: 400 });
    if (!intent) return NextResponse.json({ error: '请描述要创建的模块' }, { status: 400 });

    const templateRecord = await prisma.generationTemplate.findFirst({
      where: {
        id: templateId,
        status: { in: ['draft', 'active'] },
      },
      include: TEMPLATE_INCLUDE,
    });
    if (!templateRecord) return NextResponse.json({ error: '模板不存在或不可用' }, { status: 404 });

    const template = serializeGenerationTemplate(templateRecord);
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) {
      await prisma.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'module_builder_generate',
          target_type: 'GenerationTemplate',
          target_id: template.id,
          detail: JSON.stringify({
            status: 'failed',
            reason: 'musk_api_not_configured',
            module_type: moduleType,
          }),
        },
      });
      return NextResponse.json({ error: 'Musk API 未启用或缺少 API Key，请先到 API 设置完成配置' }, { status: 503 });
    }

    const input = { template, moduleType, intent, contextText, sessionRules, contextAssetIds };
    const result = await generateModuleBuilderDraftWithLlm({ settings, input });
    const status = result.needsClarification
      ? 'draft'
      : result.validationErrors.length > 0 ? 'failed' : 'planned';
    const summary = result.needsClarification
      ? `Module Builder 需要追问：${result.questions?.[0] || '缺少关键信息'}`
      : result.draft
        ? `Module Builder 生成 ${result.draft.moduleType} 草稿：${result.draft.moduleName}`
        : 'Module Builder 未生成可保存草稿';

    const agentRun = await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.create({
        data: {
          template_id: template.id,
          user_id: user!.id,
          status,
          user_input_json: JSON.stringify({
            kind: 'module_builder',
            intent,
            contextText,
            moduleType,
            sessionRules,
            contextAssetIds,
          }),
          modifiers_json: JSON.stringify([]),
          plans_json: JSON.stringify({
            kind: 'module_builder',
            needsClarification: result.needsClarification,
            questions: result.questions || [],
            draft: result.draft || null,
            validationErrors: result.validationErrors,
          }),
          selected_plan_key: result.draft?.moduleType || moduleType,
          agent_prompt_snapshot: JSON.stringify({ moduleType, intent, contextText, sessionRules }).slice(0, 12000),
          final_prompt_snapshot: result.draft ? JSON.stringify(result.draft) : null,
          error_message: result.validationErrors.length > 0 ? result.validationErrors.join('；') : null,
          steps: {
            create: [
              {
                step_key: 'module_builder_context',
                title: '明示上下文输入',
                input_json: JSON.stringify({ template_id: template.id }),
                output_json: JSON.stringify({
                  template_id: template.id,
                  visible_context_length: contextText.length,
                  hidden_template_rules_used: false,
                  hidden_template_prompts_used: false,
                  hidden_template_assets_used: false,
                }),
                sort_order: 1,
              },
              {
                step_key: 'module_builder_rules',
                title: 'LLM生成规则设定',
                input_json: JSON.stringify({ defaultRules, sessionRules }),
                output_json: JSON.stringify({ moduleType, contextAssetIds }),
                sort_order: 2,
              },
              {
                step_key: 'llm_generate',
                title: 'LLM 生成模块草稿',
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
        include: { steps: { orderBy: { sort_order: 'asc' } } },
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
            kind: 'module_builder',
            moduleType,
            needsClarification: result.needsClarification,
            validationErrors: result.validationErrors,
            adminModified: false,
          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'module_builder_generate',
          target_type: 'GenerationTemplate',
          target_id: template.id,
          detail: JSON.stringify({
            status,
            agent_run_id: run.id,
            module_type: result.draft?.moduleType || moduleType,
            needs_clarification: result.needsClarification,
            validation_errors: result.validationErrors.length,
          }),
        },
      });

      return run;
    });

    return NextResponse.json({
      ok: true,
      agent_run_id: agentRun.id,
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
    console.error('[ModuleBuilder] Generate failed:', error);
    return NextResponse.json({ error: 'Module Builder 生成失败' }, { status: 500 });
  }
}
