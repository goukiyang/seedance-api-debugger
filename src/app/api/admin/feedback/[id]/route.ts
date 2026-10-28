import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { feedbackPrisma } from '@/lib/feedback/notification';
import { feedbackLifecycleView, markFeedbackFixed } from '@/lib/feedback/lifecycle';
import { FeedbackFlowError } from '@/lib/feedback/flow-state';

const VALID_STATUS = new Set(['new', 'reviewed', 'archived']);

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const search = new URL(request.url).searchParams;
  if (search.get('lifecycle') === '1') {
    try {
      const result = await feedbackLifecycleView(feedbackPrisma, admin.id, params.id, {
        admin: true, ...(search.has('round') ? { round: Number(search.get('round')) } : {}),
      });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return errorJson(error instanceof FeedbackFlowError ? error.message : '处理记录暂不可核对', error instanceof FeedbackFlowError ? error.status : 503);
    }
  }

  const feedback = await prisma.feedback.findUnique({
    where: { id: params.id },
    include: { user: { select: { id: true, name: true, username: true, email: true } } },
  });
  if (!feedback) return errorJson('反馈不存在', 404);
  return NextResponse.json({ feedback });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    if (body?.action === 'mark_fixed') {
      try {
        const result = await feedbackPrisma.$transaction(tx => markFeedbackFixed(tx, admin.id, params.id, body));
        return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        return errorJson(error instanceof FeedbackFlowError ? error.message : '修复记录未确认，请保留原操作编号重新读取', error instanceof FeedbackFlowError ? error.status : 503);
      }
    }
    const data: {
      status?: string;
      admin_note?: string | null;
      archived_at?: Date | null;
      archived_by?: string | null;
    } = {};

    if (body.status !== undefined) {
      const status = text(body.status);
      if (!VALID_STATUS.has(status)) return errorJson('状态不正确', 400);
      data.status = status;
      if (status === 'archived') {
        data.archived_at = new Date();
        data.archived_by = admin.id;
      } else {
        data.archived_at = null;
        data.archived_by = null;
      }
    }
    if (body.adminNote !== undefined || body.admin_note !== undefined) {
      data.admin_note = text(body.adminNote ?? body.admin_note) || null;
    }

    const feedback = await prisma.feedback.update({
      where: { id: params.id },
      data,
      include: { user: { select: { id: true, name: true, username: true, email: true } } },
    });

    return NextResponse.json({ feedback });
  } catch (error) {
    console.error('[Admin Feedback PATCH]', error);
    return errorJson('更新失败', 500);
  }
}

