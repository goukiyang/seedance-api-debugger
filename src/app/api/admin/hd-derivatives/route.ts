import { getSession } from '@/lib/auth/session';
import { hdStatus, retryFailedHd, setHdControl } from '@/lib/media/hd-derivatives';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET() {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403, headers });
  return Response.json(await hdStatus(), { headers });
}
export async function POST(request: Request) {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403, headers });
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: '请求来源无效' }, { status: 403, headers });
  const body = await request.json();
  if (body.action === 'pause') await setHdControl(true, 'admin_pause');
  else if (body.action === 'resume') await setHdControl(false);
  else if (body.action === 'retry') await retryFailedHd();
  else return Response.json({ error: '操作无效' }, { status: 400, headers });
  return Response.json(await hdStatus(), { headers });
}
