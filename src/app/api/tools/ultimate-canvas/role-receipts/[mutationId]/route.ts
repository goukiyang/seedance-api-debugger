import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { roleReceipt } from '@/lib/canvas-roles/repository';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, props: { params: Promise<{ mutationId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, user => roleReceipt(user, params.mutationId));
}
