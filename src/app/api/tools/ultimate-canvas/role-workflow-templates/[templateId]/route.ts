import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { readRoleTemplate, updateRoleTemplate } from '@/lib/canvas-roles/templates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  const version = request.nextUrl.searchParams.get('version');
  return roleRoute(request, false, async user => roleReadResponse(request,
    await readRoleTemplate(user, params.templateId, version === null ? undefined : Number(version))));
});
export const PATCH = declaredRoute({ access: 'internal', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => updateRoleTemplate(user, params.templateId, body));
});
