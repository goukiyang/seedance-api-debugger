import { NextRequest, NextResponse } from 'next/server';
import { listAdminStudioRuns, withAdminStudioRoute } from '@/lib/template-studio/admin-runs';
import type { StudioRunStatus, StudioTemplateSource } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withAdminStudioRoute(async (user) => {
    const params = request.nextUrl.searchParams;
    const result = await listAdminStudioRuns(user, {
      cursor: params.get('cursor') || undefined,
      status: (params.get('status') || undefined) as StudioRunStatus | undefined,
      ownerUserId: params.get('owner_user_id') || undefined,
      requestId: params.get('request_id') || undefined,
      draftId: params.get('draft_id') || undefined,
      templateId: params.get('template_id') || undefined,
      templateSource: (params.get('template_source') || undefined) as StudioTemplateSource | undefined,
      createdAfter: params.get('created_after') || undefined,
      createdBefore: params.get('created_before') || undefined,
    });
    return NextResponse.json(result);
  });
}
