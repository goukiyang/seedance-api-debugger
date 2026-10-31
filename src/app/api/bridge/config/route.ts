import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getBridgeUser } from '@/lib/bridge/panel-token';
import { listBundles, parseGroups, resolveConfig, storeBundle, storeGroups, verifyBundle } from '@/lib/bridge/config';

export const dynamic = 'force-dynamic';

/** 插件拉取：GET /api/bridge/config?shell=0.2.11&channel=stable（管理员加 &list=1 查看已存规则包） */
export async function GET(request: NextRequest) {
  try {
    const user = await getBridgeUser(request);
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    const sp = request.nextUrl.searchParams;
    if (sp.get('list') === '1') {
      if (user.role !== 'admin') return NextResponse.json({ error: '无权限', ok: false }, { status: 403 });
      return NextResponse.json({ ok: true, bundles: await listBundles() });
    }
    const shell = (sp.get('shell') || '0').slice(0, 20);
    const body = await resolveConfig(user, shell, sp.get('channel') || 'stable');
    const text = JSON.stringify(body);
    const etag = '"' + crypto.createHash('sha256').update(text).digest('base64url').slice(0, 27) + '"';
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } });
    }
    return new NextResponse(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'private, no-cache' },
    });
  } catch (error) {
    console.error('[bridge/config GET]', error);
    return NextResponse.json({ error: '读取配置失败', ok: false }, { status: 500 });
  }
}

/** 管理员发布：{ kind: 'rules', bundle: { rules, rulesSig } } 或 { kind: 'groups', doc: {...} } */
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    if (user.role !== 'admin') return NextResponse.json({ error: '无权限', ok: false }, { status: 403 });
    // 防跨站提交：带 Origin 时必须是本站
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    if (origin && host && new URL(origin).host !== host.split(',')[0].trim()) {
      return NextResponse.json({ error: '来源不允许', ok: false }, { status: 403 });
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'JSON 解析失败', ok: false }, { status: 400 });
    }
    if (body.kind === 'rules') {
      const v = verifyBundle(body.bundle);
      if (!v.ok) return NextResponse.json({ error: v.error, ok: false }, { status: 400 });
      return NextResponse.json({ ok: true, bundles: await storeBundle(v.bundle, user.id) });
    }
    if (body.kind === 'groups') {
      const g = parseGroups(body.doc);
      if (!g.ok) return NextResponse.json({ error: g.error, ok: false }, { status: 400 });
      await storeGroups(g.doc, user.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'kind 只能是 rules 或 groups', ok: false }, { status: 400 });
  } catch (error) {
    console.error('[bridge/config POST]', error);
    return NextResponse.json({ error: '保存配置失败', ok: false }, { status: 500 });
  }
}
