import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
/**
 * DELETE /api/collections/[id]  - 删除图片集
 * PATCH /api/collections/[id]  - 更新图片集
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteCollection, updateCollection } from '@/lib/assets/collection';
import { getSession } from '@/lib/auth/session';

export const DELETE = apiRoute({ access: 'user', rateLimit: false }, async function DELETE(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    await deleteCollection(params.id, user.id);
    return NextResponse.json({ success: true });
  } catch (error) {

    return apiErrorResponse(error);
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const body = await request.json();
    const collection = await updateCollection(params.id, body, user.id);
    return NextResponse.json({ collection });
  } catch (error) {

    return apiErrorResponse(error);
  }
});
