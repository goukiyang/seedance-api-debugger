import { NextRequest } from 'next/server';
import { multiviewSourceRoute } from '@/lib/video/multiview-source-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest, { params }: { params: { shareId: string } }) {
  return multiviewSourceRoute(request, { kind: 'share', id: params.shareId }, 'source');
}
export const HEAD = GET;
export const POST = GET;
