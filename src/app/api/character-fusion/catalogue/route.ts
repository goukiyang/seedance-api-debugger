import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { readFusionCatalogue } from '@/lib/character-fusion/catalogue-repository';
import { fusionJson, fusionFailure, fusionLimit } from '../workspaces/http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request), q = request.nextUrl.searchParams;
    return fusionJson(await readFusionCatalogue(user, q.size ? { categoryId: q.get('categoryId') || undefined, q: q.get('q') || undefined, cursor: q.get('cursor') || undefined, limit: fusionLimit(q.get('limit'), 100), includeDisabled: q.get('includeDisabled') === '1' } : undefined));
  } catch (error) { return fusionFailure(error); }
}
