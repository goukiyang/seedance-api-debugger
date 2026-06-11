import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanEditAlbum } from '@/lib/reference-albums/permissions';
import {
  copyReferenceAlbumToPublic,
  PublicAlbumWorkflowError,
  normalizePublicAlbumName,
} from '@/lib/reference-albums/public-workflow';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanEditAlbum(user, params.id);

    const pendingSubmission = await prisma.publicAlbumSubmission.findFirst({
      where: {
        source_album_id: params.id,
        submitted_by_user_id: user.id,
        status: 'pending',
      },
      orderBy: { created_at: 'desc' },
    });

    return NextResponse.json({ submission: pendingSubmission });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[PublicAlbumSubmissions] Get error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const sourceAlbum = await assertCanEditAlbum(user, params.id);
    if (sourceAlbum.album_type === 'public' || sourceAlbum.album_type === 'system') {
      return NextResponse.json({ error: '公共图集不能重复提交' }, { status: 400 });
    }

    const body = await request.json();
    const folderId = typeof body.public_folder_id === 'string' ? body.public_folder_id.trim() : '';
    let name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : sourceAlbum.name;
    const description = typeof body.description === 'string'
      ? body.description.trim() || null
      : sourceAlbum.description || null;
    const submitNote = typeof body.submit_note === 'string' ? body.submit_note.trim() || null : null;
    const replacePending = body.replace === true;

    if (!folderId) return NextResponse.json({ error: '请选择公共文件夹' }, { status: 400 });
    const folder = await prisma.referenceAlbumFolder.findFirst({
      where: { id: folderId, scope: 'public', status: 'active' },
    });
    if (!folder) return NextResponse.json({ error: '公共文件夹不存在或已删除' }, { status: 404 });
    try {
      name = normalizePublicAlbumName(name);
    } catch (normalizeError) {
      if (normalizeError instanceof PublicAlbumWorkflowError) {
        return NextResponse.json({ error: normalizeError.message }, { status: normalizeError.status });
      }
      throw normalizeError;
    }

    const pending = await prisma.publicAlbumSubmission.findFirst({
      where: {
        source_album_id: sourceAlbum.id,
        submitted_by_user_id: user.id,
        status: 'pending',
      },
      orderBy: { created_at: 'desc' },
    });
    if (pending && replacePending) {
      const replaced = await prisma.publicAlbumSubmission.update({
        where: { id: pending.id },
        data: {
          public_folder_id: folder.id,
          name,
          description,
          submit_note: submitNote,
          status: 'pending',
          reviewed_by_user_id: null,
          reviewed_at: null,
          review_note: null,
        },
      });
      let submission = replaced;
      await prisma.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'reference_album_public_submit_replace',
          target_type: 'ReferenceAlbum',
          target_id: sourceAlbum.id,
          detail: JSON.stringify({ submission_id: submission.id, public_folder_id: folder.id }),
        },
      });

      if (user.role !== 'admin') {
        return NextResponse.json({ submission, replaced: true });
      }

      const publicAlbum = await copyReferenceAlbumToPublic({
        sourceAlbumId: sourceAlbum.id,
        publicFolderId: folder.id,
        name,
        description,
        publicOwnerUserId: user.id,
        submittedByUserId: user.id,
        submissionId: submission.id,
      });
      const approved = await prisma.publicAlbumSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'approved',
          target_album_id: publicAlbum.id,
          reviewed_by_user_id: user.id,
          reviewed_at: new Date(),
        },
      });
      return NextResponse.json({ submission: approved, public_album: publicAlbum, replaced: true });
    }
    if (pending) {
      return NextResponse.json({ submission: pending, deduplicated: true });
    }

    let submission = await prisma.publicAlbumSubmission.create({
      data: {
        source_album_id: sourceAlbum.id,
        public_folder_id: folder.id,
        submitted_by_user_id: user.id,
        name,
        description,
        submit_note: submitNote,
        status: 'pending',
      },
    }).catch(async (error) => {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
      ) {
        const duplicated = await prisma.publicAlbumSubmission.findFirst({
          where: {
            source_album_id: sourceAlbum.id,
            submitted_by_user_id: user.id,
            status: 'pending',
          },
          orderBy: { created_at: 'desc' },
        });
        if (duplicated) return duplicated;
      }
      throw error;
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_public_submit',
        target_type: 'ReferenceAlbum',
        target_id: sourceAlbum.id,
        detail: JSON.stringify({ submission_id: submission.id, public_folder_id: folder.id }),
      },
    });

    if (user.role !== 'admin') {
      return NextResponse.json({ submission, replaced: false }, { status: 201 });
    }

    const publicAlbum = await copyReferenceAlbumToPublic({
      sourceAlbumId: sourceAlbum.id,
      publicFolderId: folder.id,
      name,
      description,
      publicOwnerUserId: user.id,
      submittedByUserId: user.id,
      submissionId: submission.id,
    });
    const approved = await prisma.publicAlbumSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'approved',
        target_album_id: publicAlbum.id,
        reviewed_by_user_id: user.id,
        reviewed_at: new Date(),
      },
    });

    return NextResponse.json({ submission: approved, public_album: publicAlbum }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof PublicAlbumWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[PublicAlbumSubmissions] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
