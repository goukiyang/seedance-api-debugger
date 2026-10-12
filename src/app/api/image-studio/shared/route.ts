import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSharedStudioCatalog, sharedStudioRevision, StudioSharingError } from '@/lib/image-studio/shared-contract';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const params = request.nextUrl.searchParams;
    const mode = params.get('mode');
    const activePresetId = params.get('activePresetId') || undefined;
    const cursor = params.get('cursor') || undefined;
    const catalogRevision = params.get('catalogRevision') || undefined;
    if (mode !== null && mode !== 'revision' || [activePresetId, cursor].some(id => id && id.length > 160)
      || catalogRevision && !/^[a-f0-9]{64}$/.test(catalogRevision)) return NextResponse.json({ error: '共享目录读取参数无效' }, { status: 400, headers });
    const result = mode === 'revision' ? await sharedStudioRevision(user, activePresetId) : await listSharedStudioCatalog(user, { cursor, catalogRevision });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof StudioSharingError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    console.error('[image-studio/shared] read failed', { name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : undefined });
    return NextResponse.json({ error: '模板同步暂不可用，本人输入仍保留' }, { status: 503, headers });
  }
}
