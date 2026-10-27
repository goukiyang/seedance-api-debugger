import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readAvatarFile } from '@/lib/avatar';

export const dynamic = 'force-dynamic';
// Visible to signed-in users only; the ?v= in avatar_url changes with every new avatar, so a day of caching is safe.
export async function GET(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  if (!(await getSession())) return new Response('Not found', { status: 404 });
  const size = request.nextUrl.searchParams.get('size') === '512' ? 512 : 128;
  const bytes = /^[a-zA-Z0-9_-]{1,100}$/.test(params.userId) ? await readAvatarFile(params.userId, size) : null;
  if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, max-age=86400', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
}
