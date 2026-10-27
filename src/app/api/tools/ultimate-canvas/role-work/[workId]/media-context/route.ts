import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRoleMediaContext } from '@/lib/canvas-roles/media-bindings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest, props: { params: Promise<{ workId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => createRoleMediaContext(user, params.workId, body));
}
