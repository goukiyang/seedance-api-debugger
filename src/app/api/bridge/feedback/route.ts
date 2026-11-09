import { traceHttpRequest } from '@/lib/performance/request-trace';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { feedbackPrisma } from '@/lib/feedback/notification';
import { assertFeedbackIdentity, FeedbackSubmissionError, readFeedbackSubmission, submitFeedback } from '@/lib/feedback/submission';

const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  return NextResponse.json({ success: false, error: error instanceof FeedbackSubmissionError ? error.message : '提交结果待确认，请核对原提交。',
    code: error instanceof FeedbackSubmissionError ? error.code : 'FEEDBACK_RESULT_UNKNOWN' },
  { status: error instanceof FeedbackSubmissionError ? error.status : 503, headers });
}
async function identity(expected: unknown) {
  const user = await getSession();
  if (!user) throw new FeedbackSubmissionError('请登录 SD2 后提交反馈', 'FEEDBACK_AUTH_REQUIRED', 401);
  assertFeedbackIdentity(expected, user.id);
  return user;
}
export async function GET(request: NextRequest) {
  return traceHttpRequest('feedback.bridge-read', request.headers, async () => {
  try {
    const query = request.nextUrl.searchParams, user = await identity(query.get('expectedUserId'));
    const receipt = await readFeedbackSubmission(feedbackPrisma, user.id, query.get('operationId'));
    return NextResponse.json(receipt ? { ...receipt.result, replayed: true, status: 'accepted' } : { success: true, status: 'not_found' }, { headers });
  } catch (error) { return failure(error); }
  });
}
export async function POST(request: NextRequest) {
  return traceHttpRequest('feedback.bridge-submit', request.headers, async () => {
  try {
    let body;
    try { body = await request.json(); } catch { throw new FeedbackSubmissionError('反馈内容格式无效'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FeedbackSubmissionError('反馈内容格式无效');
    const user = await identity(body.expectedUserId);
    const result = await feedbackPrisma.$transaction(tx => submitFeedback(tx, user, body, { plugin: true, userAgent: request.headers.get('user-agent') }));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) { return failure(error); }
  });
}
