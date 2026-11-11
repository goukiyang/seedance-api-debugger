import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { listFusionWorkspaces, createFusionWorkspace } from '@/lib/character-fusion/workspace.server';
import { fusionJson, fusionFailure, readFusionBody, fusionLimit } from './http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await getSessionUser(request), q = request.nextUrl.searchParams; return fusionJson(await listFusionWorkspaces(user, { archived: q.get('archived') === '1', q: q.get('q') || undefined, cursor: q.get('cursor') || undefined, limit: fusionLimit(q.get('limit'), 30) })); } catch (error) { return fusionFailure(error); }
}
export async function POST(request: NextRequest) {
  try { return fusionJson(await createFusionWorkspace(await getSessionUser(request), await readFusionBody(request))); } catch (error) { return fusionFailure(error); }
}
