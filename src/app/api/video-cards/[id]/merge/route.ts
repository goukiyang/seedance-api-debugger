import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageVideoCard } from '@/lib/video-cards/permissions';
import { mergeVideoCard } from '@/lib/video-cards/workflow';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
    const targetCardId = optionalString(body.target_video_card_id ?? body.targetVideoCardId);
    if (!targetCardId) return NextResponse.json({ error: '必须选择目标视频卡' }, { status: 400 });
    await assertCanManageVideoCard(user, targetCardId);

    const result = await prisma.$transaction((tx) => mergeVideoCard(tx, {
      sourceCardId: params.id,
      targetCardId,
      actorUserId: user.id,
      reason: optionalString(body.reason),
    }));

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('[VideoCardMerge] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
