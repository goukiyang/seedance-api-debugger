import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { displayUserName } from '@/lib/users/display';

export const dynamic = 'force-dynamic';

async function assertAdmin() {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ error: '未登录' }, { status: 401 }), user: null };
  if (user.role !== 'admin') return { error: NextResponse.json({ error: '只有管理员可以查看公共图集提交' }, { status: 403 }), user: null };
  return { error: null, user };
}

export async function GET(request: NextRequest) {
  try {
    const { error } = await assertAdmin();
    if (error) return error;

    const status = request.nextUrl.searchParams.get('status') || 'pending';
    const where = status === 'all' ? {} : { status };
    const submissions = await prisma.publicAlbumSubmission.findMany({
      where,
      orderBy: [{ created_at: 'desc' }],
      take: 80,
      include: { publicFolder: true },
    });

    const sourceAlbumIds = Array.from(new Set(submissions.map((item) => item.source_album_id)));
    const submittedByIds = Array.from(new Set(submissions.map((item) => item.submitted_by_user_id)));

    const [sourceAlbums, submitters] = await Promise.all([
      sourceAlbumIds.length > 0
        ? prisma.referenceAlbum.findMany({
            where: { id: { in: sourceAlbumIds } },
            include: {
              owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
              images: {
                where: { status: 'active' },
                orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
                select: { id: true },
                take: 1,
              },
              _count: { select: { images: { where: { status: 'active' } } } },
            },
          })
        : Promise.resolve([]),
      submittedByIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: submittedByIds } },
            select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true },
          })
        : Promise.resolve([]),
    ]);

    const albumById = new Map(sourceAlbums.map((album) => [album.id, album]));
    const submitterById = new Map(submitters.map((user) => [user.id, user]));

    return NextResponse.json({
      submissions: submissions.map((submission) => {
        const album = albumById.get(submission.source_album_id);
        const submitter = submitterById.get(submission.submitted_by_user_id);
        return {
          ...submission,
          submitted_by: submitter ? {
            id: submitter.id,
            name: displayUserName(submitter),
            username: submitter.username,
            email: submitter.email,
            avatar_url: submitter.avatar_url,
            account_type: submitter.account_type,
          } : null,
          public_folder: submission.publicFolder,
          source_album: album ? {
            id: album.id,
            name: album.name,
            description: album.description,
            image_count: album._count.images,
            cover_image_url: album.images[0]?.id
              ? `/api/reference-images/${album.images[0].id}/content?variant=thumbnail`
              : null,
            owner: album.owner,
          } : null,
        };
      }),
    });
  } catch (error) {
    console.error('[AdminPublicAlbumSubmissions] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
