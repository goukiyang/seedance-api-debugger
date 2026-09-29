import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getVideoContext, saveVideoContext } from '@/lib/template-studio/context';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return withStudioRoute(async user => NextResponse.json(await getVideoContext(user, request.nextUrl.searchParams.get('draftId') || undefined), { headers: { 'Cache-Control': 'no-store' } }));
}
export async function PUT(request: NextRequest) {
  return withStudioRoute(async user => NextResponse.json(await saveVideoContext(user, await readStudioJson(request), request.nextUrl.searchParams.get('draftId') || undefined)));
}
