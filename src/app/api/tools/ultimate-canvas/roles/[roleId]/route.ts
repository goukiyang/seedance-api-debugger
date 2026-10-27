import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { getRole, editRole } from '@/lib/canvas-roles/repository';
import { integer } from '@/lib/canvas-roles/types';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ roleId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, user => getRole(user, params.roleId, request.nextUrl.searchParams.has('version') ? integer(Number(request.nextUrl.searchParams.get('version'))) : undefined));
});
export const PATCH = declaredRoute({ access: 'internal', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ roleId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => editRole(user, params.roleId, body, (request.headers.get('x-canvas-capabilities') || '').split(',')));
});
