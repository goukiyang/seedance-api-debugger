import { NextRequest } from 'next/server';
import { withAnimationAuth } from '@/lib/animation/http';
import { serveAnimationExportRequest } from '@/lib/animation/request-handlers';

export const runtime = 'nodejs';

type RouteContext = { params: { exportId: string } };

async function serve(request: NextRequest, exportId: string, head: boolean) {
  return withAnimationAuth(request, false, (user) => serveAnimationExportRequest(request, exportId, head, user));
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  return serve(request, params.exportId, false);
}

export async function HEAD(request: NextRequest, { params }: RouteContext) {
  return serve(request, params.exportId, true);
}
