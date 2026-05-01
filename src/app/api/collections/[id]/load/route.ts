/**
 * POST /api/collections/[id]/load
 * 加载图片集到当前工作区
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { loadCollectionIntoWorkspace, getCollectionById } from '@/lib/assets/collection';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId);

    const collection = await getCollectionById(params.id);
    if (!collection) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }

    const result = await loadCollectionIntoWorkspace(params.id, workspaceId);

    return NextResponse.json({ success: true, count: result.count });
  } catch (error) {
    console.error('[LoadCollection] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
