import { getImageResultNext, prepareVideoWorkspace, ImageResultNextError } from '@/lib/image-result-next/server';
import { imageNextBody, imageNextError, imageNextJson, imageNextUser } from '@/lib/image-result-next/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, props: { params: Promise<{ receiptId: string }> }) {
  const params = await props.params;
  try { return imageNextJson(await getImageResultNext(await imageNextUser(request), params.receiptId)); }
  catch (error) { return imageNextError(error); }
}
export async function POST(request: Request, props: { params: Promise<{ receiptId: string }> }) {
  const params = await props.params;
  try {
    const user = await imageNextUser(request), body = await imageNextBody(request);
    if (body.action !== 'prepare-video' || Object.keys(body).length !== 1) throw new ImageResultNextError('恢复动作无效');
    await prepareVideoWorkspace(user, params.receiptId);
    return imageNextJson(await getImageResultNext(user, params.receiptId));
  } catch (error) { return imageNextError(error); }
}
