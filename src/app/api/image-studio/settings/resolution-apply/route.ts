import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { executeResolutionOperation, readResolutionOperations, ResolutionApplyError } from '@/lib/image-studio/resolution-apply';
import { StudioSettingsClearConfirmationError } from '@/lib/image-studio/settings';
import { parseStudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { getImageGenerationChannels, selectImageGenerationSettings } from '@/lib/integrations/image-generation';
import { studioFourToOneIssue, supportsStudioFourToOne } from '@/lib/image-generation/resolution';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function response(data: unknown, status = 200) { return NextResponse.json(data, { status, headers }); }
function failure(error: unknown) {
  if (error instanceof AuthError || error instanceof ResolutionApplyError) return response({ error: error.message,
    ...(error instanceof ResolutionApplyError && error.requestId ? { requestId: error.requestId } : {}) }, error.status);
  if (error instanceof StudioSettingsClearConfirmationError) return response({ error: error.message }, 409);
  if (error instanceof SyntaxError) return response({ error: '操作内容无效' }, 400);
  return response({ error: '本次结果尚未确认，请查询原操作编号后重试；不要新建同一批次' }, 503);
}
export async function GET(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    return response(await readResolutionOperations(user.id, request.nextUrl.searchParams.get('requestId') || undefined,
      Number(request.nextUrl.searchParams.get('cursor') || 0)));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    if (!origin || new URL(origin).host !== host || request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: '请从本站设置页面发起操作' }, 403);
    const text = await request.text();
    if (text.length > 12 * 1024 * 1024) return response({ error: '操作内容超过安全容量' }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response({ error: '操作内容无效' }, 400);
    if ((body.action === 'prepare' || body.action === 'commit') && body.settings?.templateDefaults) {
      let defaults;
      try { defaults = parseStudioTemplateDefaults(body.settings.templateDefaults); }
      catch { return response({ error: '模板默认值无效' }, 400); }
      if (defaults.aspectRatio === '4:1') {
        const channels = await getImageGenerationChannels();
        const api = selectImageGenerationSettings(channels, defaults.model);
        const issue = studioFourToOneIssue(defaults.aspectRatio, supportsStudioFourToOne(defaults.model, api.provider));
        if (issue) return response({ error: issue }, 400);
      }
    }
    return response(await executeResolutionOperation(user.id, body));
  } catch (error) { return failure(error); }
}
