import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { listVisibleResourceDescriptors } from '@/lib/resources';

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const resources = await listVisibleResourceDescriptors(user);
    return NextResponse.json({ resources });
  } catch {
    return errorJson('未登录', 401);
  }
}
