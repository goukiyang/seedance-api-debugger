import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject } from '@/lib/projects/permissions';
import { confirmFeishuRequirementDraft } from '@/lib/feishu/requirements';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const requirement = await prisma.feishuRequirement.findUnique({
      where: { id: params.id },
      select: { id: true, created_project_id: true },
    });
    if (!requirement?.created_project_id) {
      return NextResponse.json({ error: '飞书需求草稿不存在' }, { status: 404 });
    }
    if (user.role !== 'admin') {
      await assertCanManageProject(user, requirement.created_project_id);
    }

    const updated = await prisma.$transaction((tx) => confirmFeishuRequirementDraft(tx, {
      requirementId: params.id,
      actorUserId: user.id,
    }));

    return NextResponse.json({ requirement: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[FeishuRequirements] Confirm error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
