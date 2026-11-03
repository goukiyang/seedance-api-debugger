import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { workAccessSql } from './access';
import { WorkError } from './types';

/** A small authorized name directory, independent of the currently cached card pages. */
export async function readWorkFilters(user: SessionUser, params: URLSearchParams) {
  const kind = params.get('kind') || 'authors', search = (params.get('q') || '').trim().slice(0, 80);
  if (!['authors', 'projects'].includes(kind)) throw new WorkError('筛选目录类型无效');
  const requested = Number(params.get('limit')), limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(40, requested) : 20;
  const fingerprint = createHash('sha256').update(JSON.stringify([user.id, kind, search])).digest('hex');
  const signature = (body: string) => createHmac('sha256', process.env.SESSION_SECRET || 'works-local-window-v1').update(body).digest('base64url');
  let after: { name: string; id: string } | null = null;
  if (params.get('after')) {
    try {
      const raw = params.get('after')!; if (raw.length > 2000) throw new Error();
      const [body, supplied, extra] = raw.split('.'), expected = Buffer.from(signature(body)), actual = Buffer.from(supplied || '');
      if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const value = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (value.query !== fingerprint || typeof value.name !== 'string' || typeof value.id !== 'string') throw new Error();
      after = { name: value.name, id: value.id };
    } catch { throw new WorkError('筛选目录位置已变化，请重新读取', 409); }
  }
  const access = await workAccessSql(prisma, user);
  const name = kind === 'authors' ? Prisma.sql`CASE WHEN length(trim(directory.name)) > 0 AND instr(directory.name, '@') = 0
    AND directory.name GLOB '*[^0-9+ -]*' THEN trim(directory.name) ELSE '同事' END` : Prisma.sql`directory.name`;
  const query = search ? Prisma.sql`AND ${name} LIKE ${'%' + search.replace(/[\\%_]/g, '\\$&') + '%'} ESCAPE ${'\\'}` : Prisma.empty;
  const cursor = after ? Prisma.sql`AND (${name} > ${after.name} OR (${name} = ${after.name} AND directory.id > ${after.id}))` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`WITH ${access.ctes}
    SELECT directory.id, ${name} AS name FROM ${kind === 'authors' ? Prisma.raw('User') : Prisma.raw('Project')} directory
    WHERE ${kind === 'projects' ? Prisma.sql`${access.projectView(Prisma.sql`directory.id`)} AND` : Prisma.empty}
      EXISTS (SELECT 1 FROM Work w ${access.joins} WHERE w.${kind === 'authors' ? Prisma.raw('author_id') : Prisma.raw('project_id')} = directory.id
        AND w.discoverable = 1 AND (${access.canPreview})) ${query} ${cursor}
    ORDER BY ${name} ASC, directory.id ASC LIMIT ${limit + 1}`);
  const items = rows.slice(0, limit), last = items[items.length - 1];
  const body = last ? Buffer.from(JSON.stringify({ query: fingerprint, name: last.name, id: last.id })).toString('base64url') : null;
  return { viewerId: user.id, items, nextCursor: rows.length > limit && body ? `${body}.${signature(body)}` : null };
}
