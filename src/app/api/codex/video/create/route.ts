import { NextRequest } from 'next/server';
import { POST as createVideoTask } from '@/app/api/tasks/create/route';
import { authenticateCodexVideoApi, CodexApiAuthError, prepareCodexVideoCreation } from '@/lib/integrations/codex';
import { CreationError } from '@/lib/creation/contract';
import { videoPricingError } from '@/lib/pricing/video';
import { AuthError } from '@/lib/auth/session';
import { VideoPromptGroupError } from '@/lib/video/prompt-groups';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const parsed: unknown = await request.clone().json().catch(() => null);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).creation_contract_version === 2) {
    try {
      const { user } = await authenticateCodexVideoApi(request);
      const body = await prepareCodexVideoCreation(user, parsed as Record<string, unknown>);
      return createVideoTask(new NextRequest(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }));
    } catch (error) {
      const pricing = videoPricingError(error);
      if (pricing) return Response.json({ error: pricing.code, code: pricing.code, message: pricing.message }, { status: pricing.status, headers: { 'Cache-Control': 'private, no-store' } });
      if (error instanceof CreationError || error instanceof CodexApiAuthError || error instanceof AuthError || error instanceof VideoPromptGroupError) {
        const code = error instanceof AuthError ? 'creation_result_unknown' : error.code;
        return Response.json({ error: code, code, message: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
      }
      throw error;
    }
  }
  return createVideoTask(request);
}
