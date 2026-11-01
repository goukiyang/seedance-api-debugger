import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getBridgeUser } from '@/lib/bridge/panel-token';
import { readExtMeta, storeExtPackage } from '@/lib/bridge/ext-package';

export const dynamic = 'force-dynamic';

/** 插件查询最新安装包：{ version, sha256, sig, notes, size }；还没上传过返回 version: null */
export async function GET(request: NextRequest) {
  const user = await getBridgeUser(request);
  if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
  const meta = await readExtMeta();
  return NextResponse.json({ ok: true, ...(meta || { version: null }) }, { headers: { 'Cache-Control': 'no-store' } });
}

/** 管理员上传：{ version, zip(base64), sig, notes? }，签名由 tools/publish-ext.mjs 离线生成，服务端再验 */
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    if (user.role !== 'admin') return NextResponse.json({ error: '无权限', ok: false }, { status: 403 });
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    if (origin && host) {
      let same = false;
      try { same = new URL(origin).host === host.split(',')[0].trim(); } catch { same = false; }
      if (!same) return NextResponse.json({ error: '来源不允许', ok: false }, { status: 403 });
    }
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'JSON 解析失败', ok: false }, { status: 400 }); }
    const r = await storeExtPackage(body, user.id);
    if (!r.ok) return NextResponse.json({ error: r.error, ok: false }, { status: 400 });
    return NextResponse.json({ ok: true, meta: r.meta });
  } catch (error) {
    console.error('[bridge/ext/latest POST]', error);
    return NextResponse.json({ error: '上传失败', ok: false }, { status: 500 });
  }
}
