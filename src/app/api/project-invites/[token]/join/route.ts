import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { joinProjectInvite } from '@/lib/projects/operations';

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
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

    return apiErrorResponse(error);
  }
});
