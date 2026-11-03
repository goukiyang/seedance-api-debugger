import 'server-only';

import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess, workAccessSql, type WorkPermissionRow } from './access';
import { assertWorkId } from './interactions';
import { runWorkOperation } from './operations';
import { projectWorkCards } from './query';
import { WorkError } from './types';
import type { WorkDerivationPage } from './learning-types';

type LinkKey = WorkPermissionRow & { completed_at: Date; project_visible: number | bigint; link_id: string; link_created_at: Date;
  source_work_id: string; derived_work_id: string; source_media_version_id: string; derived_media_version_id: string; author_id: string; link_revision: number };
const keys = new Set(['viewerId', 'requestId', 'expectedMediaVersion', 'derivedWorkId', 'expectedDerivedMediaVersion', 'expectedRevision', 'linkId']);
const conflict = () => new WorkError('作品关联已变化，请重新读取后再操作', 409, 'WORK_DERIVATION_VERSION_CONFLICT');

/** Permission and both media versions are filtered before taking a bounded page. */
export async function readWorkDerivations(user: SessionUser, workId: string, params: URLSearchParams): Promise<WorkDerivationPage> {
  assertWorkId(workId);
  const version = params.get('version'); assertWorkId(version, '作品版本');
  const after = params.get('after'); if (after) assertWorkId(after, '浏览位置');
  const target = params.get('derivedWorkId'); if (target) assertWorkId(target, '实践作品编号');
  const direction = params.get('direction') || 'derived';
  if (!['derived', 'source'].includes(direction)) throw new WorkError('关联方向无效');
  return prisma.$transaction(async tx => {
    const current = await getWorkAccess(user, workId, tx);
    if (!current?.canPreview) throw new WorkError('作品已不可用或当前无权查看', 404, 'WORK_UNAVAILABLE');
    if (current.media.id !== version) throw conflict();
    let ownRevision: number | undefined;
    if (target) {
      const derived = await getWorkAccess(user, target, tx);
      if (!derived?.canPreview || derived.work.author_id !== user.id) throw new WorkError('只能关联自己有权查看的实践作品', 403, 'WORK_DERIVATION_NOT_OWNED');
      const ownLink = await tx.workDerivedLink.findUnique({ where: { source_work_id_derived_work_id_author_id: {
        source_work_id: workId, derived_work_id: target, author_id: user.id,
      } }, select: { revision: true } });
      ownRevision = ownLink?.revision || 0;
    }
    const cursor = after ? await tx.workDerivedLink.findFirst({ where: {
      id: after, ...(direction === 'derived' ? { source_work_id: workId, source_media_version_id: version } : { derived_work_id: workId, derived_media_version_id: version }),
    }, select: { created_at: true, id: true } }) : null;
    if (after && !cursor) throw new WorkError('浏览位置已失效，请重新读取', 409, 'WORK_DERIVATION_CURSOR_INVALID');
    const access = await workAccessSql(tx, user);
    const ownSide = direction === 'derived' ? Prisma.sql`l.source_work_id = ${workId} AND l.source_media_version_id = ${version}
      AND l.derived_work_id = w.id AND l.derived_media_version_id = v.id`
      : Prisma.sql`l.derived_work_id = ${workId} AND l.derived_media_version_id = ${version}
      AND l.source_work_id = w.id AND l.source_media_version_id = v.id`;
    const rows = await tx.$queryRaw<LinkKey[]>(Prisma.sql`WITH ${access.ctes}
      SELECT w.id, v.id AS media_id, w.revision AS work_revision, w.completed_at,
        (${access.canPreview}) AS can_preview, (${access.canDownload}) AS can_download, (${access.canReuse}) AS can_reuse,
        (${access.nativePreview}) AS native_preview, ${access.referenceId} AS reference_id,
        (${access.projectView(Prisma.sql`w.project_id`)}) AS project_visible,
        l.id AS link_id, l.created_at AS link_created_at, l.source_work_id, l.derived_work_id,
        l.source_media_version_id, l.derived_media_version_id, l.author_id, l.revision AS link_revision
      FROM WorkDerivedLink l JOIN Work w ON ${direction === 'derived' ? Prisma.sql`w.id = l.derived_work_id` : Prisma.sql`w.id = l.source_work_id`}
      ${access.joins} WHERE ${ownSide} AND l.removed_at IS NULL AND (${access.canPreview})
        ${cursor ? Prisma.sql`AND (l.created_at > ${cursor.created_at} OR (l.created_at = ${cursor.created_at} AND l.id > ${cursor.id}))` : Prisma.empty}
      ORDER BY l.created_at ASC, l.id ASC LIMIT 21`);
    const page = rows.slice(0, 20), cards = await projectWorkCards(access.user, page, tx);
    const byId = new Map(cards.map(card => [card.id, card]));
    return { viewerId: user.id, workId, mediaVersion: version, ...(ownRevision !== undefined ? { ownRevision } : {}), items: page.flatMap(row => {
      const work = byId.get(row.id); if (!work) return [];
      return [{ work, link: { id: row.link_id, sourceWorkId: row.source_work_id, derivedWorkId: row.derived_work_id,
        sourceMediaVersion: row.source_media_version_id, derivedMediaVersion: row.derived_media_version_id,
        revision: Number(row.link_revision), createdAt: new Date(row.link_created_at).toISOString(), canEdit: row.author_id === user.id } }];
    }), nextCursor: rows.length > 20 ? page[19].link_id : null };
  }, { timeout: 15000 });
}

export async function mutateWorkDerivation(user: SessionUser, workId: string, input: Record<string, unknown>, remove: boolean) {
  assertWorkId(workId);
  if (Object.keys(input).some(key => !keys.has(key)) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
    throw new WorkError('关联参数无效', 400, 'WORK_DERIVATION_INPUT_INVALID');
  }
  assertWorkId(input.expectedMediaVersion, '作品版本');
  if (remove) assertWorkId(input.linkId, '关联编号');
  else { assertWorkId(input.derivedWorkId, '实践作品编号'); assertWorkId(input.expectedDerivedMediaVersion, '实践作品版本'); }
  const expected = input.expectedMediaVersion, expectedRevision = input.expectedRevision as number;
  const operation = await runWorkOperation(user, { viewerId: input.viewerId, requestId: input.requestId,
    intent: { kind: 'work-derivation', workId, remove, ...input } }, async (tx, actor) => {
    const source = await getWorkAccess(actor, workId, tx);
    if (!source?.canPreview) throw new WorkError('原作品已不可用或当前无权查看', 404, 'WORK_UNAVAILABLE');
    if (source.media.id !== expected) throw conflict();
    const current = remove ? await tx.workDerivedLink.findUnique({ where: { id: input.linkId as string } })
      : await tx.workDerivedLink.findUnique({ where: { source_work_id_derived_work_id_author_id: {
        source_work_id: workId, derived_work_id: input.derivedWorkId as string, author_id: actor.id,
      } } });
    if (remove && (!current || current.source_work_id !== workId || current.author_id !== actor.id || current.removed_at)) {
      throw new WorkError('只能取消本人声明的关联', 403, 'WORK_DERIVATION_NOT_OWNED');
    }
    if ((current?.revision || 0) !== expectedRevision) throw conflict();
    if (remove) {
      if (current!.source_media_version_id !== expected) throw conflict();
      const changed = await tx.workDerivedLink.updateMany({ where: { id: current!.id, author_id: actor.id, revision: expectedRevision, removed_at: null },
        data: { removed_at: new Date(), revision: { increment: 1 } } });
      if (changed.count !== 1) throw conflict();
      return { kind: 'work-derivation', workId, linkId: current!.id, revision: expectedRevision + 1, removed: true };
    }
    if (input.derivedWorkId === workId) throw new WorkError('请选择另一件本人实践作品');
    const derived = await getWorkAccess(actor, input.derivedWorkId as string, tx);
    if (!derived?.canPreview || derived.work.author_id !== actor.id) throw new WorkError('只能关联自己有权查看的实践作品', 403, 'WORK_DERIVATION_NOT_OWNED');
    if (derived.media.id !== input.expectedDerivedMediaVersion) throw conflict();
    if (current) {
      const changed = await tx.workDerivedLink.updateMany({ where: { id: current.id, author_id: actor.id, revision: expectedRevision }, data: {
        source_media_version_id: expected, derived_media_version_id: derived.media.id, removed_at: null, revision: { increment: 1 },
      } });
      if (changed.count !== 1) throw conflict();
      return { kind: 'work-derivation', workId, linkId: current.id, revision: expectedRevision + 1, removed: false };
    }
    const link = await tx.workDerivedLink.create({ data: { source_work_id: workId, derived_work_id: derived.work.id, author_id: actor.id,
      source_media_version_id: expected, derived_media_version_id: derived.media.id } });
    return { kind: 'work-derivation', workId, linkId: link.id, revision: link.revision, removed: false };
  });
  return { viewerId: user.id, operation };
}
