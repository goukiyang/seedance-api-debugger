import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  encodeDiagDetail, listDiagUploads, MAX_DIAG_BYTES, readDiagUpload, saveDiagUpload,
  uploadBodyStatus, uploadSizeStatus,
} from '@/lib/bridge/diag-uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ ok: false, error: '未登录' }, { status: 401, headers });

    const declared = Number(request.headers.get('content-length') || 0);
    if (uploadSizeStatus(declared)) return NextResponse.json({ ok: false, error: '诊断日志超过 600KB' }, { status: 413, headers });

    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ ok: false, error: '请求体无效' }, { status: 400, headers });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (uploadSizeStatus(size)) {
        await reader.cancel();
        return NextResponse.json({ ok: false, error: '诊断日志超过 600KB' }, { status: 413, headers });
      }
      chunks.push(value);
    }

    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    if (uploadBodyStatus(body)) return NextResponse.json({ ok: false, error: '请求体必须是对象且包含 items 数组' }, { status: 400, headers });
    const detail = encodeDiagDetail(body as Record<string, unknown>);
    if (!detail) return NextResponse.json({ ok: false, error: `诊断日志超过 ${MAX_DIAG_BYTES / 1024}KB` }, { status: 413, headers });

    const saved = await saveDiagUpload(user.id, detail);
    if (!saved) return NextResponse.json({ ok: false, error: '每小时最多上传 20 次' }, { status: 429, headers });
    return NextResponse.json({ ok: true, ...saved }, { headers });
  } catch (error) {
    console.error('[bridge/diag-uploads] POST', error);
    return NextResponse.json({ ok: false, error: '保存诊断日志失败' }, { status: 500, headers });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ ok: false, error: '未登录' }, { status: 401, headers });
    if (user.role !== 'admin') return NextResponse.json({ ok: false, error: '仅管理员可查看' }, { status: 403, headers });

    const sp = request.nextUrl.searchParams;
    if (sp.has('code')) {
      const normalized = (sp.get('code') || '').toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalized)) return NextResponse.json({ ok: false, error: '编号无效' }, { status: 400, headers });
      const upload = await readDiagUpload(normalized);
      return upload ? NextResponse.json({ ok: true, ...upload }, { headers })
        : NextResponse.json({ ok: false, error: '未找到诊断日志' }, { status: 404, headers });
    }
    if (sp.get('latest') === '1') {
      const upload = await readDiagUpload();
      return upload ? NextResponse.json({ ok: true, ...upload }, { headers })
        : NextResponse.json({ ok: false, error: '暂无诊断日志' }, { status: 404, headers });
    }
    return NextResponse.json({ ok: true, uploads: await listDiagUploads() }, { headers });
  } catch (error) {
    console.error('[bridge/diag-uploads] GET', error);
    return NextResponse.json({ ok: false, error: '读取诊断日志失败' }, { status: 500, headers });
  }
}
