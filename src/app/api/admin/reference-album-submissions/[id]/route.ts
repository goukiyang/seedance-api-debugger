import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import {
  copyReferenceAlbumToPublic,
  PublicAlbumWorkflowError,
} from '@/lib/reference-albums/public-workflow';

export const dynamic = 'force-dynamic';

async function assertAdmin() {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ error: '未登录' }, { status: 401 }), user: null };
  if (user.role !== 'admin') return { error: NextResponse.json({ error: '只有管理员可以审核公共图集提交' }, { status: 403 }), user: null };
  return { error: null, user };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const { error, user } = await assertAdmin();
    if (error) return error;
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const action = body.action === 'reject' ? 'reject' : 'approve';
    const reviewNote = typeof body.review_note === 'string' ? body.review_note.trim() || null : null;

    const submission = await prisma.publicAlbumSubmission.findUnique({
      where: { id: params.id },
    });
    if (!submission) return NextResponse.json({ error: '提交记录不存在' }, { status: 404 });
    if (submission.status !== 'pending') {
      return NextResponse.json({ error: '提交记录已处理' }, { status: 400 });
    }

    if (action === 'reject') {
      const rejected = await prisma.publicAlbumSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'rejected',
          review_note: reviewNote,
          reviewed_by_user_id: user.id,
          reviewed_at: new Date(),
        },
      });

      await prisma.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'reference_album_public_reject',
          target_type: 'PublicAlbumSubmission',
          target_id: submission.id,
          detail: JSON.stringify({ review_note: reviewNote }),
        },
      });

      return NextResponse.json({ submission: rejected });
    }

    const publicFolderId = typeof body.public_folder_id === 'string' && body.public_folder_id.trim()
      ? body.public_folder_id.trim()
      : submission.public_folder_id;
    if (!publicFolderId) return NextResponse.json({ error: '请选择公共文件夹' }, { status: 400 });

    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : submission.name;
    const description = typeof body.description === 'string'
      ? body.description.trim() || null
      : submission.description;

    const publicAlbum = await copyReferenceAlbumToPublic({
      sourceAlbumId: submission.source_album_id,
      publicFolderId,
      name,
      description,
      publicOwnerUserId: user.id,
      submittedByUserId: submission.submitted_by_user_id,
      submissionId: submission.id,
    });

    const approved = await prisma.publicAlbumSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'approved',
        target_album_id: publicAlbum.id,
        public_folder_id: publicFolderId,
        name,
        description,
        review_note: reviewNote,
        reviewed_by_user_id: user.id,
        reviewed_at: new Date(),
      },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_public_approve',
        target_type: 'PublicAlbumSubmission',
        target_id: submission.id,
        detail: JSON.stringify({ public_album_id: publicAlbum.id, public_folder_id: publicFolderId }),
      },
    });

    return NextResponse.json({ submission: approved, public_album: publicAlbum });
  } catch (error) {
    if (error instanceof PublicAlbumWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminPublicAlbumSubmissions] Review error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
