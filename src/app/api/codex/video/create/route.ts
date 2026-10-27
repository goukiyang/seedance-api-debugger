import { route as apiRoute } from '@/lib/http/route';
import { cookieOrCodexIdentity } from '@/lib/http/route-identities';
import { NextRequest } from 'next/server';
import { createVideoTask } from '@/server/video-tasks/create';

export const dynamic = 'force-dynamic';

export const POST = apiRoute({ access: 'user', identity: cookieOrCodexIdentity, rateLimit: false }, async function POST(request: NextRequest) {
  return createVideoTask(request);
});
