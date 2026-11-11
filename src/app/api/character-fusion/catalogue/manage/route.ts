import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { manageFusionCatalogue, queryCatalogueOperation } from '@/lib/character-fusion/catalogue-repository';
import { fusionJson, fusionFailure, readFusionBody } from '../../workspaces/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { return fusionJson(await queryCatalogueOperation(await getSessionUser(request), request.nextUrl.searchParams.get('opId') || '')); } catch (error) { return fusionFailure(error); }
}
export async function POST(request: NextRequest) {
  try { return fusionJson(await manageFusionCatalogue(await getSessionUser(request), await readFusionBody(request))); } catch (error) { return fusionFailure(error); }
}
