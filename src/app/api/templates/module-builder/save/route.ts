import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import {
  parseModuleBuilderAgentResponse,
  validateModuleBuilderDraft,
  type ModuleBuilderDraft,
} from '@/lib/templates/module-builder';
import {
  buildTemplateModuleLibraryItem,
  buildTemplateModulePatch,
  getTemplateModuleLibrary,
  saveTemplateModuleLibrary,
  upsertTemplateModuleInLibrary,
  type TemplateModuleScope,
} from '@/lib/templates/module-library';
import {
  buildTemplateWritePayload,
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
} from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeScope(value: unknown): TemplateModuleScope {
  return value === 'global' ? 'global' : 'template';
}

function normalizeDraft(value: unknown): ModuleBuilderDraft | null {
  if (!value) return null;
  const parsed = parseModuleBuilderAgentResponse(JSON.stringify(value));
  return parsed.draft || null;
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);

    const body = await request.json() as Record<string, unknown>;
    const templateId = cleanString(body.template_id);
    const agentRunId = cleanString(body.agent_run_id) || null;
    const moduleId = cleanString(body.module_id) || null;
    const sessionRules = cleanString(body.session_rules) || null;
    const scope = normalizeScope(body.scope);
    const applyToTemplate = body.apply_to_template !== false;
    const adminModified = body.admin_modified === true;
    const draft = normalizeDraft(body.draft);
    const validationErrors = validateModuleBuilderDraft(draft);

    if (!templateId) return NextResponse.json({ error: '请选择模板' }, { status: 400 });
    if (!draft || validationErrors.length) {
      return NextResponse.json({ error: '模块草稿不完整', validation_errors: validationErrors }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const templateRecord = await tx.generationTemplate.findFirst({
        where: { id: templateId, status: { in: ['draft', 'active'] } },
        include: TEMPLATE_INCLUDE,
      });
      if (!templateRecord) throw new Error('TEMPLATE_NOT_FOUND');

      const template = serializeGenerationTemplate(templateRecord);
      const library = await getTemplateModuleLibrary(tx);
      const existingModule = moduleId
        ? library.modules.find((item) => item.id === moduleId) || null
        : library.modules.find((item) => (
          item.source.template_id === template.id
          && item.module_type === draft.moduleType
          && item.name === draft.moduleName
        )) || null;
      const moduleItem = buildTemplateModuleLibraryItem({
        draft,
        template,
        actorUserId: user!.id,
        sessionRules,
        agentRunId,
        existingModule,
        adminModified,
        scope,
        status: 'active',
      });
      const nextLibrary = upsertTemplateModuleInLibrary(library, moduleItem);
      await saveTemplateModuleLibrary(nextLibrary, user!.id, tx);

      let updatedTemplate = null;
      if (applyToTemplate) {
        const patch = buildTemplateModulePatch(template, moduleItem);
        const payload = buildTemplateWritePayload(patch, user!.id);

        await tx.templateAsset.deleteMany({ where: { template_id: template.id } });
        await tx.templateRule.deleteMany({ where: { template_id: template.id } });
        await tx.templatePromptBlock.deleteMany({ where: { template_id: template.id } });

        updatedTemplate = await tx.generationTemplate.update({
          where: { id: template.id },
          data: {
            ...payload.data,
            assets: { create: payload.assets.map((asset) => ({
              asset_type: asset.asset_type,
              label: asset.label,
              url: asset.url,
              thumbnail_url: asset.thumbnail_url,
              reference_image_id: asset.reference_image_id,
              sort_order: asset.sort_order,
              status: asset.status,
              metadata_json: JSON.stringify(asset.metadata || {}),
            })) },
            rules: { create: payload.rules.map((rule) => ({
              rule_type: rule.rule_type,
              content: rule.content,
              priority: rule.priority,
              sort_order: rule.sort_order,
              status: rule.status,
            })) },
            prompts: { create: payload.prompts.map((prompt) => ({
              block_type: prompt.block_type,
              content: prompt.content,
              sort_order: prompt.sort_order,
              status: prompt.status,
            })) },
          },
          include: TEMPLATE_INCLUDE,
        });
      }

      if (agentRunId) {
        await tx.agentRun.updateMany({
          where: { id: agentRunId, template_id: template.id },
          data: {
            status: 'completed',
            completed_at: new Date(),
            final_prompt_snapshot: JSON.stringify(moduleItem.versions[moduleItem.versions.length - 1]?.content || draft),
            user_edited: adminModified,
          },
        });
      }

      await tx.templateMemory.create({
        data: {
          template_id: template.id,
          user_id: user!.id,
          agent_run_id: agentRunId,
          memory_type: 'note',
          signal: 'positive',
          summary: `保存模块：${moduleItem.name}（${moduleItem.module_type} v${moduleItem.current_version}）`,
          metadata_json: JSON.stringify({
            kind: 'module_builder_save',
            module_id: moduleItem.id,
            version: moduleItem.current_version,
            applyToTemplate,
            adminModified,
            sessionRules,
          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'module_builder_save',
          target_type: 'GenerationTemplate',
          target_id: template.id,
          detail: JSON.stringify({
            module_id: moduleItem.id,
            module_type: moduleItem.module_type,
            version: moduleItem.current_version,
            scope,
            apply_to_template: applyToTemplate,
            agent_run_id: agentRunId,
          }),
        },
      });

      return {
        moduleItem,
        template: updatedTemplate ? serializeGenerationTemplate(updatedTemplate) : null,
      };
    });

    return NextResponse.json({
      ok: true,
      module: result.moduleItem,
      template: result.template,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: '模板不存在或不可用' }, { status: 404 });
    }
    if (error instanceof Error && error.message.startsWith('LLM ')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === '模板名称不能为空') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[ModuleBuilder] Save failed:', error);
    return NextResponse.json({ error: '模块保存失败' }, { status: 500 });
  }
}
