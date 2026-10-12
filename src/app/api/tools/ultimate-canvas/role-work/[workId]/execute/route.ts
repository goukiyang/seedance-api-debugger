import { NextRequest, NextResponse } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { executeWork } from '@/lib/canvas-roles/execution';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest, { params }: { params: { workId: string } }) {
  return roleRoute(request, true, async (user, body) => {
    const result = await executeWork(user, params.workId, body);
    return NextResponse.json(result, { status: 'dispatchId' in result ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
  });
}
