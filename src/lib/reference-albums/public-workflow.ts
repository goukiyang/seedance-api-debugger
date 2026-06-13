import { prisma } from '@/lib/prisma';

export class PublicAlbumWorkflowError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

interface CopyToPublicParams {
  sourceAlbumId: string;
  publicFolderId: string;
  name: string;
  description: string | null;
  publicOwnerUserId: string;
  submittedByUserId: string;
  submissionId?: string | null;
}

export function normalizePublicAlbumName(name: string) {
  const normalized = name.trim();
  if (normalized.length > 80) {
    throw new PublicAlbumWorkflowError('公共图集名称不能超过 80 个字符');
  }
  return normalized;
}

export async function copyReferenceAlbumToPublic(params: CopyToPublicParams) {
  const name = normalizePublicAlbumName(params.name);
  if (!name) throw new PublicAlbumWorkflowError('公共图集名称不能为空');

  return prisma.$transaction(async (tx) => {
    const folder = await tx.referenceAlbumFolder.findFirst({
      where: { id: params.publicFolderId, scope: 'public', status: 'active' },
    });
    if (!folder) throw new PublicAlbumWorkflowError('公共文件夹不存在或已删除', 404);

    const sourceAlbum = await tx.referenceAlbum.findFirst({
      where: { id: params.sourceAlbumId, status: { not: 'deleted' } },
      include: {
        images: {
          where: { status: 'active' },
          orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        },
      },
    });
    if (!sourceAlbum) throw new PublicAlbumWorkflowError('源图集不存在', 404);
    if (sourceAlbum.album_type === 'public' || sourceAlbum.album_type === 'system') {
      throw new PublicAlbumWorkflowError('公共图集不能重复提交到公共库');
    }
    if (sourceAlbum.images.length === 0) {
      throw new PublicAlbumWorkflowError('空图集不能提交到公共库');
    }

    const publicAlbum = await tx.referenceAlbum.create({
      data: {
        owner_user_id: params.publicOwnerUserId,
        public_folder_id: folder.id,
        name,
        description: params.description?.trim() || sourceAlbum.description || null,
        album_type: 'public',
        visibility: 'public',
        status: 'active',
      },
    });

    const copiedImageIds: string[] = [];
    let coverImageId: string | null = null;

    for (let index = 0; index < sourceAlbum.images.length; index += 1) {
      const sourceImage = sourceAlbum.images[index];
      const copied = await tx.referenceImage.create({
        data: {
          album_id: publicAlbum.id,
          workspace_id: null,
          project_id: null,
          owner_user_id: sourceImage.owner_user_id || params.submittedByUserId,
          asset_id: sourceImage.asset_id,
          url: sourceImage.url,
          thumbnail_url: sourceImage.thumbnail_url,
          source_type: 'copied',
          source_content_id: sourceImage.source_content_id,
          source_image_id: sourceImage.id,
          sort_order: index,
          metadata_json: JSON.stringify({
            copied_from_album_id: sourceAlbum.id,
            copied_from_image_id: sourceImage.id,
            public_submission_id: params.submissionId || null,
            submitted_by_user_id: params.submittedByUserId,
          }),
          status: 'active',
        },
      });
      copiedImageIds.push(copied.id);
      if (sourceAlbum.cover_image_id === sourceImage.id) {
        coverImageId = copied.id;
      }
    }

    if (!coverImageId && copiedImageIds[0]) {
      coverImageId = copiedImageIds[0];
    }
    if (coverImageId) {
      await tx.referenceAlbum.update({
        where: { id: publicAlbum.id },
        data: { cover_image_id: coverImageId },
      });
    }

    await tx.operationLog.create({
      data: {
        operator_id: params.publicOwnerUserId,
        action: 'reference_album_public_copy',
        target_type: 'ReferenceAlbum',
        target_id: publicAlbum.id,
        detail: JSON.stringify({
          source_album_id: sourceAlbum.id,
          public_folder_id: folder.id,
          image_count: copiedImageIds.length,
          submitted_by_user_id: params.submittedByUserId,
          submission_id: params.submissionId || null,
        }),
      },
    });

    return publicAlbum;
  });
}
