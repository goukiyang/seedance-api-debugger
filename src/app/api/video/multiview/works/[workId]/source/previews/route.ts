import { NextRequest } from 'next/server';
import { multiviewSourceRoute } from '@/lib/video/multiview-source-api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, props: { params: Promise<{ workId: string }> }) {
  const params = await props.params;
  return multiviewSourceRoute(request, { kind: 'work', id: params.workId }, 'previews');
}
export const HEAD = GET;
