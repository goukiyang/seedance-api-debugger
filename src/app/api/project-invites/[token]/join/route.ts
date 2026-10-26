import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { joinProjectInvite } from '@/lib/projects/operations';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: '未登录', message: '请先登录后再加入项目' },
        { status: 401 },
      );
    }

    const result = await prisma.$transaction(tx => joinProjectInvite(tx, user, params.token));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[ProjectInvites] Join error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
