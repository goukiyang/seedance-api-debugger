import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { createStudioTemplate, listStudioTemplates } from '@/lib/template-studio/templates';
import type { CreateStudioTemplateRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const query = request.nextUrl.searchParams;
    const result = await listStudioTemplates(user, {
      cursor: query.get('cursor') || undefined,
      search: query.get('search') || undefined,
      group: query.get('group') || undefined,
    });
    return NextResponse.json(result);
  });
});

export const POST = declaredRoute({ access: 'internal', rateLimit: false }, async function POST(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const template = await createStudioTemplate(user, await readStudioJson(request) as CreateStudioTemplateRequest);
    return NextResponse.json({ template }, { status: 201 });
  });
});
