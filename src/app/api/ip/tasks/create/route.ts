import { route as apiRoute } from '@/lib/http/route';
import { cookieOrCodexIdentity } from '@/lib/http/route-identities';
import type { NextRequest } from 'next/server';
import { createVideoTask } from '@/server/video-tasks/create';

export const POST = apiRoute({ access: 'user', identity: cookieOrCodexIdentity, rateLimit: false },
  (request: NextRequest) => createVideoTask(request, 'ip'));
