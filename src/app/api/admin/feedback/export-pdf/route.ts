import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { createFeedbackPdf } from '@/lib/feedback/pdf';

export const runtime = 'nodejs';
export const maxDuration = 60;

function exportFilename(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `feedback_export_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.pdf`;
}

export async function POST(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const requestedIds = Array.isArray(body.feedbackIds) ? body.feedbackIds : body.ids;
    const ids = Array.isArray(requestedIds)
      ? Array.from(new Set(requestedIds
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim()))
        .map((id: string) => id.trim())))
        .slice(0, 100)
      : [];
    if (!ids.length) return errorJson('请选择反馈', 400);

    const feedbacks = await prisma.feedback.findMany({
      where: { id: { in: ids } },
      include: { user: { select: { name: true, username: true, email: true } } },
    });
    const feedbackById = new Map(feedbacks.map((feedback) => [feedback.id, feedback]));
    const orderedFeedbacks = ids.flatMap((id) => {
      const feedback = feedbackById.get(id);
      return feedback ? [feedback] : [];
    });

    if (!orderedFeedbacks.length) return errorJson('反馈不存在', 404);

    const pdf = await createFeedbackPdf(orderedFeedbacks);
    return new NextResponse(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${exportFilename()}"`,
      },
    });
  } catch (error) {
    console.error('[Admin Feedback Export PDF]', error);
    return errorJson('导出失败', 500);
  }
}
