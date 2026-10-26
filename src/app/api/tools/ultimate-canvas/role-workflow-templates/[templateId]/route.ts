import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { readRoleTemplate, updateRoleTemplate } from '@/lib/canvas-roles/templates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { templateId: string } }) {
  const version = request.nextUrl.searchParams.get('version');
  return roleRoute(request, false, async user => roleReadResponse(request,
    await readRoleTemplate(user, params.templateId, version === null ? undefined : Number(version))));
}
export function PATCH(request: NextRequest, { params }: { params: { templateId: string } }) {
  return roleRoute(request, true, (user, body) => updateRoleTemplate(user, params.templateId, body));
}
