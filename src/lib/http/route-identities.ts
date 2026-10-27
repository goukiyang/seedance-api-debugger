import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authenticateCodexVideoApi, hasCodexApiAuthSignal } from '@/lib/integrations/codex';

export async function cookieOrCodexIdentity(request: NextRequest) {
  // An explicitly supplied invalid service credential never falls back to a cookie.
  if (hasCodexApiAuthSignal(request)) return (await authenticateCodexVideoApi(request)).user;
  return getSession();
}

export async function authenticateCodexService(request: NextRequest) {
  await authenticateCodexVideoApi(request);
  return true;
}
