/**
 * DELETE /api/workspace/assets/[assetId]
 * 从工作区移除素材（不删除 Asset 本身）
 *
 * PATCH /api/workspace/assets/[assetId]
 * 更新素材角色（首帧/尾帧）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace, removeAssetFromWorkspace } from '@/lib/assets/workspace';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { assetId: string } }
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const tabId = _request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);
    await removeAssetFromWorkspace(workspaceId, params.assetId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[RemoveAssetFromWorkspace] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { assetId: string } }
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const { role } = body;

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    // 找到 workspace asset 并更新 role
    const updated = await prisma.workspaceAsset.updateMany({
      where: {
        workspace_id: workspaceId,
        asset_id: params.assetId,
      },
      data: {
        role: role ?? null,
      },
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: 'Asset not found in workspace' }, { status: 404 });
    }

    return NextResponse.json({ success: true, role });
  } catch (error) {
    console.error('[UpdateWorkspaceAssetRole] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
