import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { executeWorkspaceOperation, queryWorkspaceOperation, readWorkspaceHistory, listUndoableWorkspaceOperations } from '@/lib/character-fusion/workspace.server';
import { fusionJson, fusionFailure, fusionLimit, readFusionBody } from '../../http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try { const actor = await getSessionUser(request), q = request.nextUrl.searchParams;
    if (q.get('history') === '1') return fusionJson(await readWorkspaceHistory(actor, params.id, { cursor: q.get('cursor') || undefined, limit: fusionLimit(q.get('limit'), 20) }));
    if (q.get('undoable') === '1') return fusionJson(await listUndoableWorkspaceOperations(actor, params.id, { limit: fusionLimit(q.get('limit'), 10) }));
    return fusionJson(await queryWorkspaceOperation(actor, params.id, q.get('opId') || ''));
  } catch (error) { return fusionFailure(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { return fusionJson(await executeWorkspaceOperation(await getSessionUser(request), params.id, await readFusionBody(request))); } catch (error) { return fusionFailure(error); }
}
