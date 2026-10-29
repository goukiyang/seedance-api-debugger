import { NextRequest } from 'next/server';
import { multiviewWorkRoute, multiviewWorkHeaders } from '@/lib/video/multiview-work-api';
import { getMultiviewWork, MultiviewWorkError } from '@/lib/video/multiview-works';
import { parseMultiviewWorkRecipe } from '@/lib/video/multiview-work-contract';
import { renderMultiviewWork } from '@/lib/video/multiview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A requested download/copy renders bytes only, without a work revision or asset registration.
export async function POST(request: NextRequest) {
  return multiviewWorkRoute(request, true, async (user, body) => {
    const work = await getMultiviewWork(user, String(body.workId || ''));
    const recipe = work.info && parseMultiviewWorkRecipe(body.recipe, work.info);
    if (work.removed || work.sourceState !== 'current' || !recipe || recipe.schema !== 3) throw new MultiviewWorkError('当前拼图来源不可用，原排版保留。');
    const result = await renderMultiviewWork(user, work.sourceTaskId, recipe, AbortSignal.any([request.signal, AbortSignal.timeout(80000)]), work.sourceId ? {kind:'work',id:work.id} : undefined);
    return new Response(new Uint8Array(result.collage), {headers:{...multiviewWorkHeaders,'Content-Type':'image/png'}});
  });
}
