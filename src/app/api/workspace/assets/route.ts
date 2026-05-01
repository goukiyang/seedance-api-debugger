/**
 * POST /api/workspace/assets
 * 添加素材到工作区
 *
 * body: { assetId, role? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { assetId, role } = body;

    if (!assetId) {
      return NextResponse.json({ error: 'assetId required' }, { status: 400 });
    }

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId);

    const waId = await addAssetToWorkspace(workspaceId, assetId, role);

    return NextResponse.json({ success: true, workspaceAssetId: waId, workspaceId });
  } catch (error) {
    console.error('[AddAssetToWorkspace] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
