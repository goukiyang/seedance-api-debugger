import { route as declaredRoute } from '@/lib/http/route';
import { getCutoutImageHandoff, prepareCutoutImageHandoff, startCutoutImageHandoff, ImageResultNextError } from '@/lib/image-result-next/server';
import { imageNextBody, imageNextError, imageNextJson, imageNextUser } from '@/lib/image-result-next/http';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request, props: { params: Promise<{ receiptId: string }> }) {
  const params = await props.params;
  try { return imageNextJson(await getCutoutImageHandoff(request, await imageNextUser(request), params.receiptId)); }
  catch (error) { return imageNextError(error); }
});
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: Request, props: { params: Promise<{ receiptId: string }> }) {
  const params = await props.params;
  try {
    const user = await imageNextUser(request), body = await imageNextBody(request);
    if (Object.keys(body).some(key => !['action', 'settings', 'confirmUnknownPrice'].includes(key))) throw new ImageResultNextError('处理内容无效');
    if (body.action === 'prepare') return imageNextJson(await prepareCutoutImageHandoff(request, user, params.receiptId));
    if (body.action === 'start') return imageNextJson(await startCutoutImageHandoff(request, user, params.receiptId, body.settings, body.confirmUnknownPrice === true));
    throw new ImageResultNextError('处理方式无效');
  } catch (error) { return imageNextError(error); }
});
