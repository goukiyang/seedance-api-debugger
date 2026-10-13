import { imageResultOriginal } from '@/lib/image-result-next/server';
import { imageNextError, imageNextUser } from '@/lib/image-result-next/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { receiptId: string } }) {
  try { return await imageResultOriginal(request, await imageNextUser(request), params.receiptId); }
  catch (error) { return imageNextError(error); }
}
export const HEAD = GET;
