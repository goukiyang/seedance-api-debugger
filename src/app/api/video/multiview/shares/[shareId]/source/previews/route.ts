import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewSourceRoute } from '@/lib/video/multiview-source-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ shareId: string }> }) {
  const params = await props.params;
  return multiviewSourceRoute(request, { kind: 'share', id: params.shareId }, 'previews');
});
export const HEAD = GET;
