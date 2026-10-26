import { createImageResultNext, findImageResultNext, prepareCutoutImageHandoff, safeImageResultReturnPath, validImageResultSource, ImageResultNextError } from '@/lib/image-result-next/server';
import { imageNextBody, imageNextError, imageNextJson, imageNextUser } from '@/lib/image-result-next/http';
export const dynamic = 'force-dynamic';
function intent(value: unknown) { if (value !== 'cutout' && value !== 'video') throw new ImageResultNextError('导入目标无效'); return value; }
export async function POST(request: Request) {
  try {
    const user = await imageNextUser(request), body = await imageNextBody(request);
    if (Object.keys(body).some(key => !['source', 'intent', 'returnPath'].includes(key))) throw new ImageResultNextError('导入内容无效');
    const target = intent(body.intent);
    const receipt = await createImageResultNext(user, validImageResultSource(body.source), target, safeImageResultReturnPath(body.returnPath));
    if (target === 'cutout') return imageNextJson(await prepareCutoutImageHandoff(request, user, receipt.receiptId));
    return imageNextJson(receipt);
  } catch (error) { return imageNextError(error); }
}
export async function GET(request: Request) {
  try {
    const user = await imageNextUser(request), params = new URL(request.url).searchParams;
    const receipt = await findImageResultNext(user, validImageResultSource(params.get('source')), intent(params.get('intent')));
    return imageNextJson({ receipt });
  } catch (error) { return imageNextError(error); }
}
