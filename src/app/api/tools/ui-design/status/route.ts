import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { readUiDocument } from '@/lib/ui-design/store';
import { uiJobStatus } from '@/lib/ui-design/generation';
import type { UiBatch } from '@/lib/ui-design/types';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await uiUser(request), id = request.nextUrl.searchParams.get('id');
    if (id) return uiJson(await uiJobStatus(user, id));
    const document = await readUiDocument(user.id, 'batch', request.nextUrl.searchParams.get('runId') || '');
    const batch = document.data as UiBatch;
    return uiJson({ document, jobs: await Promise.all(batch.jobs.map(job => uiJobStatus(user, job.id))) });
  } catch (error) { return uiFailure(error); }
}
