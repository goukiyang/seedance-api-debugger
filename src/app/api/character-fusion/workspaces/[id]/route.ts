import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { getWorkspace } from '@/lib/character-fusion/workspace.server';
import { fusionJson, fusionFailure, fusionLimit } from '../http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try { const q = request.nextUrl.searchParams; return fusionJson(await getWorkspace(await getSessionUser(request), params.id, { rowId: q.get('rowId') || undefined, batchId: q.get('batchId') || undefined, displayNo: q.has('displayNo') ? Number(q.get('displayNo')) : undefined, cursor: q.get('cursor') || undefined, limit: fusionLimit(q.get('limit'), 100) })); } catch (error) { return fusionFailure(error); }
}
