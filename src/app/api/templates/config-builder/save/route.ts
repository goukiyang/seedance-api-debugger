import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import {
  parseTemplateConfigAgentResponse,
  templateConfigDraftToTemplatePayload,
  validateTemplateConfigDraft,
  type TemplateConfigDraft,
} from '@/lib/templates/template-config-builder';
import {
  buildTemplateWritePayload,
  normalizeTemplateKey,
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
} from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeDraft(value: unknown): TemplateConfigDraft | null {
  if (!value) return null;
  const parsed = parseTemplateConfigAgentResponse(JSON.stringify(value));
  return parsed.draft || null;
}

function bumpVersion(version: string) {
  const match = version.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i);
  if (!match) return `${version}-next`;
  const major = Number(match[1] || 1);
  const minor = Number(match[2] || 0);
  const patch = Number(match[3] || 0) + 1;
  return `v${major}.${minor}.${patch}`;
}

async function uniqueTemplateKey(
  client: Prisma.TransactionClient | typeof prisma,
  baseValue: string,
  fallbackName: string,
  excludeId?: string,
) {
  const base = normalizeTemplateKey(baseValue, fallbackName);
  let candidate = base;
  for (let index = 2; index < 100; index += 1) {
    const existing = await client.generationTemplate.findUnique({
      where: { template_key: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}_${index}`;
  }
  return `${base}_${Date.now()}`;
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  try {
    requireAdmin(user);

    const body = await request.json() as Record<string, unknown>;
    const templateId = cleanString(body.template_id);
    const agentRunId = cleanString(body.agent_run_id) || null;
    const mode = body.mode === 'new_version' ? 'new_version' : 'draft';
    const draft = normalizeDraft(body.draft);
    const validationErrors = validateTemplateConfigDraft(draft);
    if (!draft || validationErrors.length) {
      return NextResponse.json({ error: '模板配置草稿不完整', validation_errors: validationErrors }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const payloadSource = templateConfigDraftToTemplatePayload(draft);
      if (templateId) {
        const existing = await tx.generationTemplate.findFirst({
          where: { id: templateId, status: { in: ['draft', 'active'] } },
          include: TEMPLATE_INCLUDE,
        });
        if (!existing) throw new Error('TEMPLATE_NOT_FOUND');
        payloadSource.template_key = await uniqueTemplateKey(
          tx,
          payloadSource.template_key || existing.template_key,
          payloadSource.name,
          existing.id,
        );
        if (mode === 'new_version') payloadSource.version = bumpVersion(existing.version);
        if (mode === 'draft') payloadSource.status = 'draft';
        const payload = buildTemplateWritePayload(payloadSource, user!.id);

        await tx.templateAsset.deleteMany({ where: { template_id: existing.id } });
        await tx.templateRule.deleteMany({ where: { template_id: existing.id } });
        await tx.templatePromptBlock.deleteMany({ where: { template_id: existing.id } });

        const updated = await tx.generationTemplate.update({
          where: { id: existing.id },
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

        if (agentRunId) {
          await tx.agentRun.updateMany({
            where: { id: agentRunId, template_id: existing.id },
            data: {
              status: 'completed',
              completed_at: new Date(),
              final_prompt_snapshot: JSON.stringify(draft),
              user_edited: true,
            },
          });
        }

        await tx.templateMemory.create({
          data: {
            template_id: updated.id,
            user_id: user!.id,
            agent_run_id: agentRunId,
            memory_type: 'note',
            signal: 'positive',
            summary: `保存模板配置：${updated.name}（${mode === 'new_version' ? '新版本' : '草稿'}）`,
            metadata_json: JSON.stringify({
              kind: 'template_config_save',
              mode,
              modulePlan: draft.modulePlan,
              validationChecklist: draft.validationChecklist,
            }),
          },
        });

        await tx.operationLog.create({
          data: {
            operator_id: user!.id,
            action: 'template_config_save',
            target_type: 'GenerationTemplate',
            target_id: updated.id,
            detail: JSON.stringify({
              mode,
              agent_run_id: agentRunId,
              template_key: updated.template_key,
              version: updated.version,
            }),
          },
        });

        return updated;
      }

      payloadSource.template_key = await uniqueTemplateKey(
        tx,
        payloadSource.template_key || payloadSource.name,
        payloadSource.name,
      );
      payloadSource.status = 'draft';
      const payload = buildTemplateWritePayload(payloadSource, user!.id);
      const created = await tx.generationTemplate.create({
        data: {
          ...payload.data,
          created_by: user!.id,
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

      await tx.templateMemory.create({
        data: {
          template_id: created.id,
          user_id: user!.id,
          agent_run_id: null,
          memory_type: 'note',
          signal: 'positive',
          summary: `LLM 新建模板草稿：${created.name}`,
          metadata_json: JSON.stringify({
            kind: 'template_config_create',
            modulePlan: draft.modulePlan,
            validationChecklist: draft.validationChecklist,
          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user!.id,
          action: 'template_config_create',
          target_type: 'GenerationTemplate',
          target_id: created.id,
          detail: JSON.stringify({
            template_key: created.template_key,
            version: created.version,
            module_count: draft.modulePlan.length,
          }),
        },
      });

      return created;
    });

    return NextResponse.json({
      ok: true,
      template: serializeGenerationTemplate(result),
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
    console.error('[TemplateConfig] Save failed:', error);
    return NextResponse.json({ error: '保存模板配置失败' }, { status: 500 });
  }
}
