import type { NextRequest } from 'next/server';
import { withApiErrors } from '@/lib/http/api-error';

export type VideoCreateChannel = 'standard' | 'ip';

// Both adapters retain the same server-authenticated actor, pricing receipt,
// submission state machine and hold settlement contracts used by the public routes.
export const createVideoTask = withApiErrors(async (request: NextRequest, channel: VideoCreateChannel = 'standard'): Promise<Response> => {
  if (channel === 'ip') {
    const { createIpVideoTask } = await import('./ip-create');
    return createIpVideoTask(request);
  }
  const { createStandardVideoTask } = await import('./standard-create');
  return createStandardVideoTask(request);
});
