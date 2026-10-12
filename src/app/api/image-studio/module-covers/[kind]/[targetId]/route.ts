import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readModuleCoverImage } from '@/lib/image-studio/module-cover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Never browser-cache protected derivatives: source/share revocation is checked on every display.
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: NextRequest, { params }: { params: { kind: string; targetId: string } }) {
  const user = await getSession();
  const revision = Number(request.nextUrl.searchParams.get('revision'));
  const size = Number(request.nextUrl.searchParams.get('size') || 640);
  if (!user || !['module', 'preset'].includes(params.kind) || !Number.isSafeInteger(revision) || revision < 1 || ![640, 1280].includes(size)) return new Response('Not found', { status: 404, headers });
  try {
    const bytes = await readModuleCoverImage(user, { kind: params.kind as 'module' | 'preset', id: params.targetId }, revision, size as 640 | 1280);
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } });
  } catch { return new Response('Not found', { status: 404, headers }); }
}
export const HEAD = GET;
