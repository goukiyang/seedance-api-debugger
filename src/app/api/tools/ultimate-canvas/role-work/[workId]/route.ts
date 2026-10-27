import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { readWork, actOnWork } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, props: { params: Promise<{ workId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, user => readWork(user, params.workId, request.nextUrl.searchParams));
}
export async function POST(request: NextRequest, props: { params: Promise<{ workId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => actOnWork(user, params.workId, body));
}
