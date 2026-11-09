import { traceHttpRequest } from '@/lib/performance/request-trace';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { feedbackPrisma as prisma } from '@/lib/feedback/notification';
import { assertFeedbackIdentity, FeedbackSubmissionError, readFeedbackSubmission, submitFeedback } from '@/lib/feedback/submission';

const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  return NextResponse.json({ success: false, error: error instanceof FeedbackSubmissionError ? error.message : '提交结果待确认，请保留原稿并核对原提交。',
    code: error instanceof FeedbackSubmissionError ? error.code : 'FEEDBACK_RESULT_UNKNOWN' },
  { status: error instanceof FeedbackSubmissionError ? error.status : 503, headers });
}
export async function GET(request: NextRequest) {
  return traceHttpRequest('feedback.read', request.headers, async () => {
  try {
    const user = await getSession(), query = request.nextUrl.searchParams;
    assertFeedbackIdentity(query.get('expectedUserId') || null, user?.id ?? null);
    const receipt = await readFeedbackSubmission(prisma, user?.id ?? null, query.get('operationId'));
    return NextResponse.json(receipt ? { ...receipt.result, replayed: true, status: 'accepted' } : { success: true, status: 'not_found' }, { headers });
  } catch (error) { return failure(error); }
  });
}
export async function POST(request: NextRequest) {
  return traceHttpRequest('feedback.submit', request.headers, async () => {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    let body;
    try { body = await request.json(); } catch { throw new FeedbackSubmissionError('反馈内容格式无效'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FeedbackSubmissionError('反馈内容格式无效');
    const user = await getSession(); userId = user?.id ?? null;
    const result = await prisma.$transaction(tx => submitFeedback(tx, user, body, { userAgent: request.headers.get('user-agent') }));
    if (userId && result.attachments.saved > 0 && !result.replayed) {
      await recordAssetUploadLog({ operatorId: userId, stage: 'mount', status: 'succeeded',
        assetId: typeof body.uploadedAssetIds?.[0] === 'string' ? body.uploadedAssetIds[0] : null,
        durationMs: Date.now() - startedAt, uploadMode: 'single', totalParts: result.attachments.saved }).catch(() => console.warn('feedback_auxiliary_log_failed'));
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    console.error('feedback_submit_failed');
    if (userId) await recordAssetUploadLog({ operatorId: userId, stage: 'mount', status: 'failed', durationMs: Date.now() - startedAt,
      errorCode: 'feedback_mount_failed', errorMessage: '提交结果待确认' }).catch(() => console.warn('feedback_auxiliary_log_failed'));
    return failure(error);
  }
  });
}
