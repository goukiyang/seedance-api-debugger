import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

const VALID_STATUS = new Set(['new', 'reviewed', 'archived']);

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
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

