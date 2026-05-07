import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { createFeedbackPdf } from '@/lib/feedback/pdf';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 100)
      : [];
    if (!ids.length) return errorJson('请选择反馈', 400);

    const feedbacks = await prisma.feedback.findMany({
      where: { id: { in: ids } },
      include: { user: { select: { name: true, username: true, email: true } } },
      orderBy: { created_at: 'desc' },
    });
    if (!feedbacks.length) return errorJson('反馈不存在', 404);

    const pdf = await createFeedbackPdf(feedbacks);
    return new NextResponse(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="feedback-batch.pdf"',
      },
    });
  } catch (error) {
    console.error('[Admin Feedback Export PDF]', error);
    return errorJson('导出失败', 500);
  }
}
