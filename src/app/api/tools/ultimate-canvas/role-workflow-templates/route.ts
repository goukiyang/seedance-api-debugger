import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { listRoleTemplates, saveRoleTemplate } from '@/lib/canvas-roles/templates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest) {
  return roleRoute(request, false, async user => roleReadResponse(request, await listRoleTemplates(user, request.nextUrl.searchParams)));
}
export function POST(request: NextRequest) { return roleRoute(request, true, saveRoleTemplate); }
