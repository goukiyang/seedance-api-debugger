import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { createFeedbackPdf } from '@/lib/feedback/pdf';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const feedback = await prisma.feedback.findUnique({
    where: { id: params.id },
    include: { user: { select: { name: true, username: true, email: true } } },
  });
  if (!feedback) return errorJson('反馈不存在', 404);

  const pdf = await createFeedbackPdf([feedback]);
  return new NextResponse(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="feedback-${feedback.id}.pdf"`,
    },
  });
}

