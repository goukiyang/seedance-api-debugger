import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanManageVideoCard,
  assertCanViewVideoCard,
} from '@/lib/video-cards/permissions';
import { createVideoBranch, getBranchSummaries } from '@/lib/video-branches';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewVideoCard(user, params.id);
    const branches = await prisma.$transaction((tx) => getBranchSummaries(tx, params.id));
    return NextResponse.json({ branches });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoBranches] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanManageVideoCard(user, params.id);
    const body = await request.json();
    const title = optionalString(body.title);
    if (!title) return NextResponse.json({ error: '方向名称不能为空' }, { status: 400 });

    const branch = await prisma.$transaction(async (tx) => {
      const created = await createVideoBranch(tx, {
        videoCardId: params.id,
        title,
        description: optionalString(body.description),
        createdBy: user.id,
        isPrimary: body.is_primary === true || body.isPrimary === true,
        confirmOverLimit: body.confirm_over_limit === true || body.confirmOverLimit === true,
      });
      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'video_branch_create',
          target_type: 'video_branch',
          target_id: created.id,
          detail: JSON.stringify({ video_card_id: params.id, is_primary: created.is_primary }),
        },
      });
      return created;
    });

    return NextResponse.json({ branch }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[VideoBranches] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
