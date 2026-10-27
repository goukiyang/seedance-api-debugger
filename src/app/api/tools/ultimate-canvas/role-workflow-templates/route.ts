import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { listRoleTemplates, saveRoleTemplate } from '@/lib/canvas-roles/templates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, function GET(request: NextRequest) {
  return roleRoute(request, false, async user => roleReadResponse(request, await listRoleTemplates(user, request.nextUrl.searchParams)));
});
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, function POST(request: NextRequest) { return roleRoute(request, true, saveRoleTemplate); });
