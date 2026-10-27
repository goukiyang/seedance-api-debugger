import { route as declaredRoute } from '@/lib/http/route';
import { imageResultOriginal } from '@/lib/image-result-next/server';
import { imageNextError, imageNextUser } from '@/lib/image-result-next/http';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request, props: { params: Promise<{ receiptId: string }> }) {
  const params = await props.params;
  try { return await imageResultOriginal(request, await imageNextUser(request), params.receiptId); }
  catch (error) { return imageNextError(error); }
});
export const HEAD = GET;
