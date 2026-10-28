import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { feedbackPrisma } from '@/lib/feedback/notification';
import { feedbackLifecycleView, reviewFeedbackFix } from '@/lib/feedback/lifecycle';
import { FeedbackFlowError } from '@/lib/feedback/flow-state';
import { feedbackActionJson } from '@/lib/feedback/action-request';

const headers = { 'Cache-Control': 'private, no-store' };
const failure = (error: unknown) => NextResponse.json({ error: error instanceof FeedbackFlowError ? error.message : '反馈记录暂不可核对，请保留原操作重新读取' }, {
  status: error instanceof FeedbackFlowError ? error.status : 503, headers,
});
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const search = request.nextUrl.searchParams;
    return NextResponse.json(await feedbackLifecycleView(feedbackPrisma, user.id, params.id,
      search.has('round') ? { round: Number(search.get('round')) } : {}), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const body = await feedbackActionJson(request);
    const result = await feedbackPrisma.$transaction(tx => reviewFeedbackFix(tx, user.id, params.id, {
      operationId: body.operationId, round: body.round, result: body.result, note: body.note,
      imageUrls: body.imageUrls, uploadedAssetIds: body.uploadedAssetIds,
    }));
    return NextResponse.json({ replayed: result.replayed, round: result.round.round,
      review: result.round.review ? { operationId: result.round.review.operationId, result: result.round.review.result, note: result.round.review.note,
        imageUrls: result.round.review.imageUrls, at: result.round.review.at } : null }, { headers });
  } catch (error) { return failure(error); }
}
