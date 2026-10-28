import { NextRequest, NextResponse } from 'next/server';
import { withMultiviewActionRoute, readMultiviewActionJson, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
import { multiviewActionContextMetadata, readMultiviewActionContextEditor, saveMultiviewActionContextDraft, saveMultiviewActionContextEditor, multiviewActionContextStatus } from '@/lib/video/multiview-action-context.server';
import type { MultiviewActionContextKind } from '@/lib/video/multiview-action-contract';
import { StudioError } from '@/lib/template-studio/errors';
export const dynamic = 'force-dynamic';
function kind(value: string): MultiviewActionContextKind { if (value !== 'format' && value !== 'sync') throw new StudioError('规则类型无效', 400, 'INVALID'); return value; }
export async function GET(request: NextRequest, { params }: { params: { kind: string } }) {
  return withMultiviewActionRoute(request, async user => {
    const type = kind(params.kind), query = request.nextUrl.searchParams, mode = query.get('mode');
    if (query.has('id') && query.get('id') !== type) throw new StudioError('规则入口不一致', 400, 'INVALID');
    if (mode === 'private-editor' || query.get('editor') === '1') return NextResponse.json(await readMultiviewActionContextEditor(user, type), { headers });
    if (mode === 'private-save-status' || mode === 'private-draft-status') return NextResponse.json(await multiviewActionContextStatus(user, type, query.get('requestId') || '', mode === 'private-draft-status'), { headers });
    return NextResponse.json(await multiviewActionContextMetadata(user, type), { headers });
  });
}
export async function PUT(request: NextRequest, { params }: { params: { kind: string } }) {
  return withMultiviewActionRoute(request, async user => {
    const type = kind(params.kind), body = await readMultiviewActionJson(request);
    if (body.id !== undefined && body.id !== type) throw new StudioError('规则入口不一致', 400, 'INVALID');
    if (body.action === 'save-private-draft') return NextResponse.json(await saveMultiviewActionContextDraft(user, type, body as unknown as Parameters<typeof saveMultiviewActionContextDraft>[2]), { headers });
    if (body.action === 'save-private-definition') return NextResponse.json(await saveMultiviewActionContextEditor(user, type, body as unknown as Parameters<typeof saveMultiviewActionContextEditor>[2]), { headers });
    throw new StudioError('规则操作无效', 400, 'INVALID');
  });
}
