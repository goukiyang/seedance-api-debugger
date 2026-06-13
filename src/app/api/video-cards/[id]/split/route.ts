import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageVideoCard } from '@/lib/video-cards/permissions';
import { splitVideoCard } from '@/lib/video-cards/workflow';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
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
    if (!title) return NextResponse.json({ error: '新视频卡标题不能为空' }, { status: 400 });

    const result = await prisma.$transaction((tx) => splitVideoCard(tx, {
      sourceCardId: params.id,
      taskIds: stringList(body.task_ids ?? body.taskIds),
      actorUserId: user.id,
      title,
      reason: optionalString(body.reason),
    }));

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('[VideoCardSplit] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
