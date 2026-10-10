import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { enqueueFeedbackNotification, feedbackPrisma as prisma } from '@/lib/feedback/notification';
import { snapshotFeedbackAttachments } from '@/lib/feedback/attachments';

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const body = await request.json();
    const content = text(body.content);

    if (!content) {
      return NextResponse.json({ error: '请输入反馈内容' }, { status: 400 });
    }
    const user = await getSession();
    userId = user?.id || null;
    const result = await prisma.$transaction(async (tx) => {
      const { snapshot, imageUrls } = await snapshotFeedbackAttachments(tx, userId, body.imageUrls, body.uploadedAssetIds);
      const saved = await tx.feedback.create({
        data: {
          user_id: user?.id || null,
          task_id: text(body.taskId) || null,
          content,
          image_urls_json: imageUrls.length ? JSON.stringify(imageUrls) : null,
          page_url: text(body.pageUrl) || null,
          pathname: text(body.pathname) || null,
          user_agent: request.headers.get('user-agent') || null,
          status: 'new',
        },
      });
      await enqueueFeedbackNotification(tx, saved, user, snapshot);
      return { feedback: saved, snapshot, imageUrls };
    });
    const { feedback, snapshot, imageUrls } = result;

    if (user?.id && imageUrls.length > 0) {
      await recordAssetUploadLog({
        operatorId: user.id,
        stage: 'mount',
        status: 'succeeded',
        assetId: snapshot.items[0]?.assetId || null,
        durationMs: Date.now() - startedAt,
        uploadMode: 'single',
        totalParts: imageUrls.length,
      }).catch(() => console.warn('feedback_auxiliary_log_failed'));
    }
    return NextResponse.json({ success: true, feedback: { id: feedback.id },
      attachments: { saved: imageUrls.length, notSaved: snapshot.total - imageUrls.length } }, { status: 201 });
  } catch (error) {
    console.error('feedback_submit_failed');
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'mount',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'feedback_mount_failed',
        errorMessage: '提交失败',
      }).catch(() => console.warn('feedback_auxiliary_log_failed'));
    }
    return NextResponse.json({ error: '提交失败，请稍后重试。' }, { status: 500 });
  }
}
