import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { readMultiviewWorkMutation } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { mutationId: string } }) {
  return multiviewWorkRoute(request, false, user => readMultiviewWorkMutation(user, params.mutationId));
}
