import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { readMultiviewShareOperation, resumeMultiviewShareOperation } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, props: { params: Promise<{ mutationId: string }> }) {
  const params = await props.params;
  return multiviewWorkRoute(request, false, user => readMultiviewShareOperation(user, params.mutationId));
}
export async function POST(request: NextRequest, props: { params: Promise<{ mutationId: string }> }) {
  const params = await props.params;
  return multiviewWorkRoute(request, true, user => resumeMultiviewShareOperation(user, params.mutationId));
}
