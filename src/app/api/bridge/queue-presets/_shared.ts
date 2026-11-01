import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { PresetError } from '@/lib/bridge/queue-presets';
import type { SessionUser } from '@/lib/auth/session';

// 插件后台（chrome-extension://）发起；配了 SD2B_EXTENSION_IDS 时只认名单内的插件
function isExtensionOrigin(origin: string) {
  if (!origin.startsWith('chrome-extension://')) return false;
  const allow = (process.env.SD2B_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allow.length || allow.includes(origin.slice('chrome-extension://'.length).replace(/\/$/, ''));
}

/** 登录（SD2 会话 cookie）+ 写操作防跨站：带 Origin 时只认本站或插件 */
export async function withUser(request: NextRequest, write: boolean, fn: (user: SessionUser) => Promise<unknown>) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ ok: false, error: '未登录' }, { status: 401 });
    if (write) {
      const origin = request.headers.get('origin');
      const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0].trim();
      if (origin && !isExtensionOrigin(origin) && new URL(origin).host !== host) {
        return NextResponse.json({ ok: false, error: '来源不允许' }, { status: 403 });
      }
    }
    const data = await fn(user);
    return NextResponse.json({ ok: true, ...(data as object) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof PresetError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    console.error('[bridge/queue-presets]', error);
    return NextResponse.json({ ok: false, error: '组合操作失败' }, { status: 500 });
  }
}

export async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    throw new PresetError('JSON 解析失败', 400);
  }
}
