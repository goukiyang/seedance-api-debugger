import { NextRequest } from 'next/server';
import { multiviewSourceRoute } from '@/lib/video/multiview-source-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest, { params }: { params: { workId: string } }) {
  return multiviewSourceRoute(request, { kind: 'work', id: params.workId }, 'video');
}
export const HEAD = GET;
