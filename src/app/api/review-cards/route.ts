import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function optionalString(value: string | null) {
  return value && value.trim() ? value.trim() : null;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const platform = optionalString(request.nextUrl.searchParams.get('platform'));
    const ratio = optionalString(request.nextUrl.searchParams.get('ratio'));
    const projectType = optionalString(request.nextUrl.searchParams.get('project_type'));
    const limitRaw = Number(request.nextUrl.searchParams.get('limit') || 20);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));

    const review_cards = await prisma.reviewCard.findMany({
      where: {
        status: { in: ['generated', 'archived'] },
        project: {
          ...(projectType ? { type: projectType } : {}),
          ...(platform || ratio
            ? {
                video_cards: {
                  some: {
                    ...(platform ? { platform } : {}),
                    ...(ratio ? { ratio } : {}),
                  },
                },
              }
            : {}),
          ...(user.role === 'admin'
            ? {}
            : {
                OR: [
                  { owner_user_id: user.id },
                  { members: { some: { user_id: user.id, status: 'active' } } },
                ],
              }),
        },
      },
      orderBy: { generated_at: 'desc' },
      take: limit,
      include: {
        project: { select: { id: true, name: true, type: true, status: true } },
      },
    });

    return NextResponse.json({ review_cards });
  } catch (error) {
    console.error('[ReviewCards] Search error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
