/**
 * Collection API Routes
 *
 * GET  /api/collections          - 列出所有图片集
 * POST /api/collections         - 创建图片集（从当前 workspace 复制）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { createCollection, getCollections } from '@/lib/assets/collection';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const collections = await getCollections(user.id);
    return NextResponse.json({ collections });
  } catch (error) {
    console.error('[GetCollections] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const { name, description, visibility } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name required' }, { status: 400 });
    }

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    const collection = await createCollection(name, workspaceId, { description, visibility, ownerId: user.id });

    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    console.error('[CreateCollection] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
