import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getVideoContext, saveVideoContext } from '@/lib/template-studio/context';
import { readPrivateVideoContextEditor, savePrivateVideoContextDraft, savePrivateVideoContextEditor, privateVideoContextStatus } from '@/lib/template-studio/private-context-editor.server';
import { StudioError } from '@/lib/template-studio/errors';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return withStudioRoute(async user => {
    const params = request.nextUrl.searchParams, mode = params.get('mode');
    if (mode === 'private-editor') return NextResponse.json(await readPrivateVideoContextEditor(user, params.get('id') || ''), { headers });
    if (mode === 'private-save-status' || mode === 'private-draft-status') return NextResponse.json(
      await privateVideoContextStatus(user, params.get('id') || '', params.get('requestId') || '', mode === 'private-draft-status'), { headers });
    return NextResponse.json(await getVideoContext(user, params.get('draftId') || undefined, params.get('private') === '1'), { headers });
  });
}
export async function PUT(request: NextRequest) {
  return withStudioRoute(async user => {
    const body = await readStudioJson(request);
    if (body?.action === 'save-private-draft' || body?.action === 'save-private-definition') {
      const origin = request.headers.get('origin'), host = request.headers.get('host');
      const protocol = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
      if (!host || /[/\\?#@,\s]/.test(host) || !['http', 'https'].includes(protocol)
        || origin !== new URL(`${protocol}://${host}`).origin) throw new StudioError('请求来源无效', 403, 'FORBIDDEN');
      return NextResponse.json(body.action === 'save-private-draft'
        ? await savePrivateVideoContextDraft(user, body.id, body) : await savePrivateVideoContextEditor(user, body.id, body), { headers });
    }
    return NextResponse.json(await saveVideoContext(user, body, request.nextUrl.searchParams.get('draftId') || undefined), { headers });
  });
}
