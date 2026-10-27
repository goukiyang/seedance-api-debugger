import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { authorizedPage, seekWhere } from '@/lib/pagination/cursor';
import { requireSecret } from '@/lib/security/secrets';

const recentColumns = [{ name: 'created_at', direction: 'desc', date: true }, { name: 'id', direction: 'desc' }] as const;
const recentOrder = [{ created_at: 'desc' }, { id: 'desc' }] as const;
const folderColumns = [{ name: 'sort_order', direction: 'asc' }, { name: 'created_at', direction: 'asc', date: true }, { name: 'id', direction: 'asc' }] as const;

export function readFolderPage(user: SessionUser, params: URLSearchParams) {
  return authorizedPage({ params, context: JSON.stringify(['album-folders', user.id, 'public', 'active']), secret: requireSecret('media'),
    fetch: (after, take) => prisma.referenceAlbumFolder.findMany({
      where: { scope: 'public', status: 'active', AND: [seekWhere([...folderColumns], after)] },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' }], take,
    }),
    key: row => [row.sort_order, row.created_at.toISOString(), row.id], visible: async () => true,
  });
}

// Callers must freshly authorize album management / admin access before reading.
export function readSharePage(user: SessionUser, albumId: string, params: URLSearchParams) {
  const now = new Date();
  return authorizedPage({ params, context: JSON.stringify(['album-shares', user.id, albumId, 'active']), secret: requireSecret('media'),
    fetch: (after, take) => prisma.albumShare.findMany({
      where: { album_id: albumId, status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: now } }], AND: [seekWhere([...recentColumns], after)] },
      orderBy: [...recentOrder], take,
    }), key: row => [row.created_at.toISOString(), row.id], visible: async () => true,
  });
}

export function readSubmissionPage(user: SessionUser, params: URLSearchParams) {
  const status = params.get('status') || 'pending';
  return authorizedPage({ params, context: JSON.stringify(['album-submissions', user.id, status]), secret: requireSecret('media'),
    fetch: (after, take) => prisma.publicAlbumSubmission.findMany({
      where: { ...(status === 'all' ? {} : { status }), AND: [seekWhere([...recentColumns], after)] },
      orderBy: [...recentOrder], take, include: { publicFolder: true },
    }), key: row => [row.created_at.toISOString(), row.id], visible: async () => true,
  });
}
