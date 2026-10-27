import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getStudioRunHandoff, saveStudioFinalText } from '@/lib/template-studio/handoff';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withStudioRoute(async (user) => NextResponse.json(await getStudioRunHandoff(user, params.id)));
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withStudioRoute(async user => NextResponse.json(await saveStudioFinalText(user, params.id, await readStudioJson(request))));
}
