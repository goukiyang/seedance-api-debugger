import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { normalizeCanvasDocumentInput } from '@/lib/canvas/document';

export const dynamic = 'force-dynamic';

function safeFileName(value: string) {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return cleaned || 'seedance-flow-canvas';
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: '只有管理员可以导出 Canvas JSON' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim() : '未命名画布';
  const document = normalizeCanvasDocumentInput(body?.document, title || '未命名画布');
  const fileName = `${safeFileName(document.title)}.json`;
  const encodedFileName = encodeURIComponent(fileName);

  return new NextResponse(JSON.stringify(document, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="seedance-flow-canvas.json"; filename*=UTF-8''${encodedFileName}`,
      'Cache-Control': 'no-store',
    },
  });
}
