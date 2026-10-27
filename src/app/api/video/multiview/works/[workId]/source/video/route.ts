import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewSourceRoute } from '@/lib/video/multiview-source-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ workId: string }> }) {
  const params = await props.params;
  return multiviewSourceRoute(request, { kind: 'work', id: params.workId }, 'video');
});
export const HEAD = GET;
