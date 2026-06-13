import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageVideoCard } from '@/lib/video-cards/permissions';
import {
  closeBranch,
  mergeBranch,
  promoteBranchToVideoCard,
  setPrimaryBranch,
} from '@/lib/video-branches';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; branchId: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanManageVideoCard(user, params.id);
    const body = await request.json();
    const action = optionalString(body.action);

    const result = await prisma.$transaction(async (tx) => {
      if (action === 'set_primary') {
        return { branch: await setPrimaryBranch(tx, { videoCardId: params.id, branchId: params.branchId, actorUserId: user.id }) };
      }
      if (action === 'close') {
        return {
          branch: await closeBranch(tx, {
            videoCardId: params.id,
            branchId: params.branchId,
            actorUserId: user.id,
            reason: optionalString(body.reason),
          }),
        };
      }
      if (action === 'merge') {
        const targetBranchId = optionalString(body.target_branch_id ?? body.targetBranchId);
        if (!targetBranchId) throw new Error('合并方向必须选择目标方向');
        return {
          branch: await mergeBranch(tx, {
            videoCardId: params.id,
            sourceBranchId: params.branchId,
            targetBranchId,
            actorUserId: user.id,
            reason: optionalString(body.reason),
          }),
        };
      }
      if (action === 'promote_to_card') {
        return await promoteBranchToVideoCard(tx, {
          videoCardId: params.id,
          branchId: params.branchId,
          actorUserId: user.id,
          title: optionalString(body.title),
          reason: optionalString(body.reason),
        });
      }
      throw new Error('action 必须是 set_primary、close、merge 或 promote_to_card');
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[VideoBranches] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
