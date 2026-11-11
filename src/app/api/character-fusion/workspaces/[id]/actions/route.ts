import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { executeWorkspaceOperation, queryWorkspaceOperation } from '@/lib/character-fusion/workspace.server';
import { fusionJson, fusionFailure, readFusionBody } from '../../http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try { return fusionJson(await queryWorkspaceOperation(await getSessionUser(request), params.id, request.nextUrl.searchParams.get('opId') || '')); } catch (error) { return fusionFailure(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { return fusionJson(await executeWorkspaceOperation(await getSessionUser(request), params.id, await readFusionBody(request))); } catch (error) { return fusionFailure(error); }
}
