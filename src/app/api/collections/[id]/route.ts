/**
 * DELETE /api/collections/[id]  - 删除图片集
 * PATCH /api/collections/[id]  - 更新图片集
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteCollection, updateCollection } from '@/lib/assets/collection';
import { getSession } from '@/lib/auth/session';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    await deleteCollection(params.id, user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DeleteCollection] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const body = await request.json();
    const collection = await updateCollection(params.id, body, user.id);
    return NextResponse.json({ collection });
  } catch (error) {
    console.error('[UpdateCollection] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
