import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import {
  buildTemplateWritePayload,
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
} from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权访问动画模板。');

    const includeInactive = user.role === 'admin' && request.nextUrl.searchParams.get('include_inactive') === 'true';
    const templates = await prisma.generationTemplate.findMany({
      where: includeInactive ? { status: { not: 'deleted' } } : { status: 'active' },
      orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
      include: TEMPLATE_INCLUDE,
    });

    return NextResponse.json({ templates: templates.map(serializeGenerationTemplate) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Templates] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    requireAdmin(user);

    const body = await request.json();
    const payload = buildTemplateWritePayload(body, user.id);
    const template = await prisma.$transaction(async (tx) => {
      const created = await tx.generationTemplate.create({
        data: {
          ...payload.data,
          created_by: user.id,
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
          action: 'generation_template_create',
          target_type: 'GenerationTemplate',
          target_id: created.id,
          detail: JSON.stringify({ template_key: created.template_key, status: created.status }),
        },
      });

      return created;
    });

    return NextResponse.json({ template: serializeGenerationTemplate(template) }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message === '模板名称不能为空') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Templates] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
