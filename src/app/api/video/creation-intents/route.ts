import { originalPreparationRejection, recordPreparationRejection } from '@/lib/creation/preparation-receipts';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getVideoCreationIntent } from '@/lib/creation/intents';
import { creationIdentity } from '@/lib/creation/contract';
import { creationHttp, creationBody } from '@/lib/creation/http';
import { prepareVideoCreationIntent } from '@/lib/creation/intents';
import { logVideoPricingFailure } from '@/lib/pricing/video';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return creationHttp(async user => { const body = await creationBody(request);
    try { return { intent: await prepareVideoCreationIntent(user, body) }; }
    catch (cause) {
      logVideoPricingFailure('preparation', cause);
      const known = cause as { status?: number; code?: string };
      if (Number.isInteger(known.status)) await recordPreparationRejection(user, body, Number(known.status), known.code);
      throw cause;
    }
  });
}

export async function GET(request: NextRequest) {
  return creationHttp(async user => {
    const requestId = creationIdentity(request.nextUrl.searchParams.get('request_id'), 'request_id')!;
    const original = await prisma.videoCreationIntent.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } } });
    const rejected = !original ? await originalPreparationRejection(prisma, user.id, requestId) : null;
    return original ? { state: original.state, intent: await getVideoCreationIntent(user, original.id) } : rejected ? { state: 'rejected', intent: null, rejection: rejected.result } : { state: 'unconfirmed', intent: null };
  });
}
