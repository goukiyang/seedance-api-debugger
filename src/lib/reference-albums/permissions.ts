import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';

export type AlbumPermissionKey =
  | 'view'
  | 'use'
  | 'copy'
  | 'download'
  | 'viewSource'
  | 'edit';

export type AlbumPermissions = Record<AlbumPermissionKey, boolean>;

export const DEFAULT_SHARE_PERMISSIONS: AlbumPermissions = {
  view: true,
  use: true,
  copy: true,
  download: false,
  viewSource: false,
  edit: false,
};

const NO_PERMISSIONS: AlbumPermissions = {
  view: false,
  use: false,
  copy: false,
  download: false,
  viewSource: false,
  edit: false,
};

const FULL_PERMISSIONS: AlbumPermissions = {
  view: true,
  use: true,
  copy: true,
  download: true,
  viewSource: true,
  edit: true,
};

type AlbumRecord = Awaited<ReturnType<typeof getAlbumByIdForAccess>>;
type ImageRecord = Awaited<ReturnType<typeof getReferenceImageByIdForAccess>>;

export function normalizeAlbumPermissions(input: unknown): AlbumPermissions {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SHARE_PERMISSIONS };
  const source = input as Partial<Record<AlbumPermissionKey, unknown>>;
  return {
    view: source.view === undefined ? true : Boolean(source.view),
    use: source.use === undefined ? true : Boolean(source.use),
    copy: source.copy === undefined ? true : Boolean(source.copy),
    download: Boolean(source.download),
    viewSource: Boolean(source.viewSource),
    edit: Boolean(source.edit),
  };
}

export function parseAlbumPermissions(json: string | null | undefined): AlbumPermissions {
  if (!json) return { ...DEFAULT_SHARE_PERMISSIONS };
  try {
    return normalizeAlbumPermissions(JSON.parse(json));
  } catch {
    return { ...DEFAULT_SHARE_PERMISSIONS };
  }
}

export function serializeAlbumPermissions(input: unknown): string {
  return JSON.stringify(normalizeAlbumPermissions(input));
}

export async function getAlbumByIdForAccess(albumId: string) {
  const now = new Date();
  return prisma.referenceAlbum.findFirst({
    where: { id: albumId, status: { not: 'deleted' } },
    include: {
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      project: { select: { id: true, name: true, owner_user_id: true, status: true } },
      shares: {
        where: {
          status: 'active',
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
      },
      _count: { select: { images: { where: { status: 'active' } } } },
    },
  });
}

export async function getReferenceImageByIdForAccess(imageId: string) {
  return prisma.referenceImage.findFirst({
    where: { id: imageId, status: 'active', album: { status: { not: 'deleted' } } },
    include: {
      asset: true,
      album: {
        include: {
          owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          project: { select: { id: true, name: true, owner_user_id: true, status: true } },
          shares: {
            where: {
              status: 'active',
              OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
            },
          },
          _count: { select: { images: { where: { status: 'active' } } } },
        },
      },
    },
  });
}

export async function getAlbumAccess(user: SessionUser, album: NonNullable<AlbumRecord>) {
  if (user.status !== 'active') return { permissions: { ...NO_PERMISSIONS }, canShare: false, role: 'blocked' };

  const isProjectScopedAlbum = Boolean(album.project_id && (album.album_type === 'project' || album.visibility === 'project'));

  if (user.role === 'admin' && !isProjectScopedAlbum) {
    return { permissions: { ...FULL_PERMISSIONS }, canShare: true, role: 'admin' };
  }

  if (album.owner_user_id === user.id && !isProjectScopedAlbum) {
    return { permissions: { ...FULL_PERMISSIONS }, canShare: true, role: 'owner' };
  }

  let permissions = { ...NO_PERMISSIONS };
  let role = 'none';
  let projectScopedCanShare = false;

  const directShare = album.shares.find((share) => share.grantee_type === 'user' && share.grantee_id === user.id);
  if (directShare) {
    permissions = mergePermissions(permissions, parseAlbumPermissions(directShare.permissions_json));
    role = 'shared_user';
  }

  for (const share of album.shares.filter((item) => item.grantee_type === 'project')) {
    const access = await getProjectAccess(user, share.grantee_id);
    if (access.canView) {
      permissions = mergePermissions(permissions, parseAlbumPermissions(share.permissions_json));
      role = role === 'none' ? 'shared_project' : role;
    }
  }

  if (isProjectScopedAlbum && album.project_id) {
    const access = await getProjectAccess(user, album.project_id);
    if (access.canView || user.role === 'admin' || album.owner_user_id === user.id) {
      const projectPermissions: AlbumPermissions = {
        view: true,
        use: access.canGenerate,
        copy: access.canGenerate,
        download: false,
        viewSource: false,
        edit: access.canManageAssets,
      };
      permissions = mergePermissions(permissions, projectPermissions);
      role = role === 'none' ? `project_${access.role}` : role;
      projectScopedCanShare = access.canManageProject;
    }
  }

  if (album.visibility === 'public' || album.album_type === 'public' || album.album_type === 'system') {
    const publicPermissions: AlbumPermissions = user.account_type === 'external'
      ? { view: true, use: true, copy: false, download: false, viewSource: false, edit: false }
      : { view: true, use: true, copy: true, download: false, viewSource: false, edit: false };
    permissions = mergePermissions(permissions, publicPermissions);
    role = role === 'none' ? 'public' : role;
  }

  if (isProjectScopedAlbum && album.project?.status !== 'active') {
    permissions.use = false;
    permissions.copy = false;
    permissions.edit = false;
  }

  const canShare = isProjectScopedAlbum
    ? projectScopedCanShare
    : permissions.edit || album.owner_user_id === user.id;
  return { permissions, canShare, role };
}

export async function canViewAlbum(user: SessionUser, album: NonNullable<AlbumRecord>) {
  return (await getAlbumAccess(user, album)).permissions.view;
}

export async function canEditAlbum(user: SessionUser, album: NonNullable<AlbumRecord>) {
  return (await getAlbumAccess(user, album)).permissions.edit;
}

export async function canShareAlbum(user: SessionUser, album: NonNullable<AlbumRecord>) {
  return (await getAlbumAccess(user, album)).canShare;
}

export async function canUseAlbumImage(user: SessionUser, image: NonNullable<ImageRecord>) {
  return (await getAlbumAccess(user, image.album)).permissions.use;
}

export async function canCopyAlbumImage(user: SessionUser, image: NonNullable<ImageRecord>) {
  return (await getAlbumAccess(user, image.album)).permissions.copy;
}

export async function canDownloadOriginal(user: SessionUser, image: NonNullable<ImageRecord>) {
  return (await getAlbumAccess(user, image.album)).permissions.download;
}

export async function canViewReferenceImage(user: SessionUser, image: NonNullable<ImageRecord>) {
  return (await getAlbumAccess(user, image.album)).permissions.view;
}

export async function assertCanViewAlbum(user: SessionUser, albumId: string) {
  const album = await getAlbumByIdForAccess(albumId);
  if (!album) throw new AuthError('图集不存在', 404);
  if (!(await canViewAlbum(user, album))) throw new AuthError('无权查看此图集', 403);
  return album;
}

export async function assertCanEditAlbum(user: SessionUser, albumId: string) {
  const album = await getAlbumByIdForAccess(albumId);
  if (!album) throw new AuthError('图集不存在', 404);
  if (!(await canEditAlbum(user, album))) throw new AuthError('无权编辑此图集', 403);
  return album;
}

export async function assertCanShareAlbum(user: SessionUser, albumId: string) {
  const album = await getAlbumByIdForAccess(albumId);
  if (!album) throw new AuthError('图集不存在', 404);
  if (!(await canShareAlbum(user, album))) throw new AuthError('无权共享此图集', 403);
  return album;
}

export async function assertCanUseReferenceImage(user: SessionUser, imageId: string) {
  const image = await getReferenceImageByIdForAccess(imageId);
  if (!image) throw new AuthError('参考图不存在', 404);
  if (!(await canUseAlbumImage(user, image))) throw new AuthError('无权使用此参考图生成', 403);
  return image;
}

export async function assertCanViewReferenceImage(user: SessionUser, imageId: string) {
  const image = await getReferenceImageByIdForAccess(imageId);
  if (!image) throw new AuthError('参考图不存在', 404);
  if (!(await canViewReferenceImage(user, image))) throw new AuthError('无权查看此参考图', 403);
  return image;
}

export async function getAuthorizedReferenceImagesForUse(user: SessionUser, imageIds: string[]) {
  const ids = uniquePreserveOrder(imageIds).slice(0, 9);
  const images = [];
  for (const id of ids) {
    images.push(await assertCanUseReferenceImage(user, id));
  }
  return images;
}

export function uniquePreserveOrder(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function canUseDirectAsset(user: SessionUser, assetId: string) {
  if (user.role === 'admin') return true;
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { owner_id: true } });
  return asset?.owner_id === user.id;
}

function mergePermissions(a: AlbumPermissions, b: AlbumPermissions): AlbumPermissions {
  return {
    view: a.view || b.view,
    use: a.use || b.use,
    copy: a.copy || b.copy,
    download: a.download || b.download,
    viewSource: a.viewSource || b.viewSource,
    edit: a.edit || b.edit,
  };
}
