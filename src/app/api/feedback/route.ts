import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

const MAX_IMAGES = 3;

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_IMAGES);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const body = await request.json();
    const content = text(body.content);
    const imageUrls = cleanImageUrls(body.imageUrls);

    if (!content) {
      return NextResponse.json({ error: '请输入反馈内容' }, { status: 400 });
    }
    if (Array.isArray(body.imageUrls) && body.imageUrls.length > MAX_IMAGES) {
      return NextResponse.json({ error: '最多上传 3 张图片' }, { status: 400 });
    }

    const user = await getSession();
    userId = user?.id || null;
    const feedback = await prisma.feedback.create({
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

    if (user?.id && imageUrls.length > 0) {
      await recordAssetUploadLog({
        operatorId: user.id,
        stage: 'mount',
        status: 'succeeded',
        assetId: Array.isArray(body.uploadedAssetIds) ? String(body.uploadedAssetIds[0] || '') : null,
        durationMs: Date.now() - startedAt,
        uploadMode: 'single',
        totalParts: imageUrls.length,
      });
    }
    return NextResponse.json({ success: true, feedback: { id: feedback.id } }, { status: 201 });
  } catch (error) {
    console.error('[Feedback POST]', error);
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'mount',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'feedback_mount_failed',
        errorMessage: error instanceof Error ? error.message : '提交失败',
      });
    }
    return NextResponse.json({ error: '提交失败，请稍后重试。' }, { status: 500 });
  }
}
