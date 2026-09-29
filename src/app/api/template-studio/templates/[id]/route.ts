import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getStudioTemplate, patchStudioTemplate } from '@/lib/template-studio/templates';
import type { PatchStudioTemplateRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const source = request.nextUrl.searchParams.get('source') === 'legacy' ? 'legacy' : 'studio';
    return NextResponse.json(await getStudioTemplate(user, params.id, source));
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const template = await patchStudioTemplate(user, params.id, await readStudioJson(request) as PatchStudioTemplateRequest);
    return NextResponse.json({ template });
  });
}
