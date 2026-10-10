import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { getRole, editRole } from '@/lib/canvas-roles/repository';
import { integer } from '@/lib/canvas-roles/types';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { roleId: string } }) {
  return roleRoute(request, false, user => getRole(user, params.roleId, request.nextUrl.searchParams.has('version') ? integer(Number(request.nextUrl.searchParams.get('version'))) : undefined));
}
export function PATCH(request: NextRequest, { params }: { params: { roleId: string } }) { return roleRoute(request, true, (user, body) => editRole(user, params.roleId, body)); }
