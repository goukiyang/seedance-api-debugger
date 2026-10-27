import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getStudioTemplate, patchStudioTemplate } from '@/lib/template-studio/templates';
import type { PatchStudioTemplateRequest } from '@/lib/template-studio/types';
import { readPrivateTemplateEditor, savePrivateTemplateDraft, savePrivateTemplateEditor, privateTemplateEditorStatus } from '@/lib/template-studio/private-template-editor.server';
import { StudioError } from '@/lib/template-studio/errors';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'private-editor') return NextResponse.json(await readPrivateTemplateEditor(user, params.id), { headers });
    if (mode === 'private-save-status' || mode === 'private-draft-status') return NextResponse.json(
      await privateTemplateEditorStatus(user, params.id, request.nextUrl.searchParams.get('requestId') || '', mode === 'private-draft-status'), { headers });
    const source = request.nextUrl.searchParams.get('source') === 'legacy' ? 'legacy' : 'studio';
    return NextResponse.json(await getStudioTemplate(user, params.id, source, request.nextUrl.searchParams.get('private') === '1'),
      { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  });
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async user => {
    const origin = request.headers.get('origin'), host = request.headers.get('host');
    const protocol = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
    if (!host || /[/\\?#@,\s]/.test(host) || !['http', 'https'].includes(protocol)
      || origin !== new URL(`${protocol}://${host}`).origin) throw new StudioError('请求来源无效', 403, 'FORBIDDEN');
    const body = await readStudioJson(request);
    if (body?.id !== params.id) throw new StudioError('模板编号不一致', 400, 'INVALID');
    if (body.action === 'save-private-draft') return NextResponse.json(await savePrivateTemplateDraft(user, params.id, body), { headers });
    if (body.action === 'save-private-definition') return NextResponse.json(await savePrivateTemplateEditor(user, params.id, body), { headers });
    throw new StudioError('操作无效', 400, 'INVALID');
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const template = await patchStudioTemplate(user, params.id, await readStudioJson(request) as PatchStudioTemplateRequest);
    return NextResponse.json({ template });
  });
}
