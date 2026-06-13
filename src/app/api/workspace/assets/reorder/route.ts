/**
 * PATCH /api/workspace/assets/reorder
 * 更新工作区素材排序
 *
 * body: { order: [{assetId, sortOrder, role?}] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace, updateWorkspaceAssetOrder } from '@/lib/assets/workspace';
import { getSession } from '@/lib/auth/session';

export async function PATCH(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const { order } = body;

    if (!Array.isArray(order)) {
      return NextResponse.json({ error: 'order must be array' }, { status: 400 });
    }

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    await updateWorkspaceAssetOrder(workspaceId, order);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[ReorderAssets] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
