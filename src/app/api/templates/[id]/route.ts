import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import {
  buildTemplateWritePayload,
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
} from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const template = await prisma.generationTemplate.findUnique({
      where: { id: params.id },
      include: TEMPLATE_INCLUDE,
    });
    if (!template || (template.status !== 'active' && user.role !== 'admin')) {
      return NextResponse.json({ error: '模板不存在或无权访问' }, { status: 404 });
    }

    return NextResponse.json({ template: serializeGenerationTemplate(template) });
  } catch (error) {
    console.error('[Templates] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await getSession();
    requireAdmin(user);

    const body = await request.json();
    const payload = buildTemplateWritePayload(body, user.id);

    const template = await prisma.$transaction(async (tx) => {
      const existing = await tx.generationTemplate.findUnique({ where: { id: params.id } });
      if (!existing) throw new Error('TEMPLATE_NOT_FOUND');

      await tx.templateAsset.deleteMany({ where: { template_id: params.id } });
      await tx.templateRule.deleteMany({ where: { template_id: params.id } });
      await tx.templatePromptBlock.deleteMany({ where: { template_id: params.id } });

      const updated = await tx.generationTemplate.update({
        where: { id: params.id },
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

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'generation_template_update',
          target_type: 'GenerationTemplate',
          target_id: updated.id,
          detail: JSON.stringify({ template_key: updated.template_key, status: updated.status }),
        },
      });

      return updated;
    });

    return NextResponse.json({ template: serializeGenerationTemplate(template) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: '模板不存在' }, { status: 404 });
    }
    if (error instanceof Error && error.message === '模板名称不能为空') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Templates] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
