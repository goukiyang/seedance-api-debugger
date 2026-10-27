import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
/**
 * GET  /api/workspace
 * 获取当前工作区（含素材列表）
 *
 * POST /api/workspace
 * 初始化/获取工作区（tabId 在 body 中传递）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace, getWorkspaceWithAssets } from '@/lib/assets/workspace';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401, headers: privateHeaders });
    const expectedOwner = request.headers.get('x-upload-owner-id');
    if (expectedOwner && expectedOwner !== user.id) return NextResponse.json({ error: '当前登录账号已变化，请重新读取工作区' }, { status: 409, headers: privateHeaders });

    // 从 header 获取 tabId（前端设置）
    const tabId = request.headers.get('x-tab-id') || 'default';

    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);
    const workspace = await getWorkspaceWithAssets(workspaceId, user);

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404, headers: privateHeaders });
    }

    return NextResponse.json({ workspace, tabId }, { headers: privateHeaders });
  } catch (error) {

    return apiErrorResponse(error);
  }
});

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401, headers: privateHeaders });
    const expectedOwner = request.headers.get('x-upload-owner-id');
    if (expectedOwner && expectedOwner !== user.id) return NextResponse.json({ error: '当前登录账号已变化，请重新读取工作区' }, { status: 409, headers: privateHeaders });

    const body = await request.json().catch(() => ({}));
    const tabId = body.tabId || request.headers.get('x-tab-id') || 'default';

    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);
    const workspace = await getWorkspaceWithAssets(workspaceId, user);

    return NextResponse.json({ workspace, tabId }, { headers: privateHeaders });
  } catch (error) {

    return apiErrorResponse(error);
  }
});
