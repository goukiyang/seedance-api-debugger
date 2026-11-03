import 'server-only';
import type { SessionUser } from '@/lib/auth/session';
import { getWorkAccess } from './access';
import { runWorkOperation } from './operations';
import { WorkError } from './types';

export async function requestWorkPreview(user: SessionUser, workId: string, input: {
  viewerId: unknown; requestId: unknown; expectedMediaVersion: unknown;
}) {
  if (typeof input.expectedMediaVersion !== 'string') throw new WorkError('请先重新读取作品');
  const expectedMediaVersion = input.expectedMediaVersion;
  return runWorkOperation(user, { ...input, intent: { action: 'prepare-preview', workId, expectedMediaVersion } }, async (db, actor) => {
    const access = await getWorkAccess(actor, workId, db);
    if (!access?.canPreview) throw new WorkError('作品当前不可用', 404);
    if (access.media.id !== expectedMediaVersion) throw new WorkError('作品版本已变化，请重新打开', 409);
    if (access.media.preview_status === 'ready') return { workId, mediaVersion: expectedMediaVersion, state: 'ready' };
    if (access.media.preview_status === 'unavailable') return { workId, mediaVersion: expectedMediaVersion, state: 'unavailable' };
    await db.workRegistrationJob.upsert({
      where: { source_kind_source_id_source_revision: { source_kind: 'media_preview', source_id: expectedMediaVersion, source_revision: expectedMediaVersion } },
      create: { source_kind: 'media_preview', source_id: expectedMediaVersion, source_revision: expectedMediaVersion,
        source_updated_at: access.media.source_updated_at || access.media.created_at },
      update: {},
    });
    return { workId, mediaVersion: expectedMediaVersion, state: 'preparing' };
  });
}
