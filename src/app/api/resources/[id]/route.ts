import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { getVisibleResourceDescriptor } from '@/lib/resources';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSessionUser(request);
    const resource = await getVisibleResourceDescriptor(params.id, user);

    if (!resource) {
      return errorJson('资源不存在或无权限访问', 404);
    }

    return NextResponse.json({ resource });
  } catch {
    return errorJson('未登录', 401);
  }
}
