import { NextRequest, NextResponse } from 'next/server';
import { uiUser, uiFailure, privateHeaders } from '@/lib/ui-design/access';
import { packageFile } from '@/lib/ui-design/runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    await uiUser(request);
    const name = params.path.join('/'), bytes = await packageFile(name, true);
    const type: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    return new NextResponse(new Uint8Array(bytes), { headers: { ...privateHeaders, 'Content-Type': type[name.split('.').pop()!] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'" } });
  } catch (error) { return uiFailure(error); }
}
