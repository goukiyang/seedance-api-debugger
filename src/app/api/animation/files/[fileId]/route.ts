import { NextRequest } from 'next/server';
import { withAnimationAuth } from '@/lib/animation/http';
import { serveAnimationFileRequest } from '@/lib/animation/request-handlers';

export const runtime = 'nodejs';

type RouteContext = { params: { fileId: string } };

async function serve(request: NextRequest, fileId: string, head: boolean) {
  return withAnimationAuth(request, false, (user) => serveAnimationFileRequest(request, fileId, head, user));
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  return serve(request, params.fileId, false);
}

export async function HEAD(request: NextRequest, { params }: RouteContext) {
  return serve(request, params.fileId, true);
}
