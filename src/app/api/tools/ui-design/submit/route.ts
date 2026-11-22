import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { confirmUiBatch, submitUiJob, stopUiBatch, closeUiJob } from '@/lib/ui-design/generation';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try { const user = await uiUser(request), input = await request.json();
    if (input.action === 'confirm') return uiJson(await confirmUiBatch(user, input));
    if (input.action === 'stop') return uiJson(await stopUiBatch(user, input.runId));
    if (input.action === 'close') return uiJson(await closeUiJob(user, input.requestId));
    return uiJson(await submitUiJob(user, input));
  } catch (error) { return uiFailure(error); }
}
