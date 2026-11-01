import { NextRequest, NextResponse } from 'next/server';
import { getBridgeUser } from '@/lib/bridge/panel-token';
import { readExtMeta, readExtZip } from '@/lib/bridge/ext-package';

export const dynamic = 'force-dynamic';

/** 下载当前安装包 zip（插件拿到后自己再核 sha256 与签名） */
export async function GET(request: NextRequest) {
  const user = await getBridgeUser(request);
  if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
  const [meta, zip] = await Promise.all([readExtMeta(), readExtZip()]);
  if (!meta || !zip) return NextResponse.json({ error: '还没有安装包', ok: false }, { status: 404 });
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename="sd2-production-bridge-${meta.version}.zip"`,
      'X-SD2B-Version': meta.version,
      'Cache-Control': 'no-store',
    },
  });
}
