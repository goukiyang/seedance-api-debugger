import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { createStudioRun, listStudioRuns } from '@/lib/template-studio/runs';
import type { CreateStudioRunRequest, StudioRunStatus, StudioTemplateSource } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const query = request.nextUrl.searchParams;
    return NextResponse.json(await listStudioRuns(user, {
      cursor: query.get('cursor') || undefined,
      requestId: query.get('request_id') || undefined,
      draftId: query.get('draft_id') || undefined,
      status: (query.get('status') || undefined) as StudioRunStatus | undefined,
      templateId: query.get('template_id') || undefined,
      templateSource: (query.get('template_source') || undefined) as StudioTemplateSource | undefined,
      createdAfter: query.get('created_after') || undefined,
      createdBefore: query.get('created_before') || undefined,
    }));
  });
}

export async function POST(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const result = await createStudioRun(user, await readStudioJson(request) as CreateStudioRunRequest);
    return NextResponse.json({ run: result.run }, { status: result.status });
  });
}
