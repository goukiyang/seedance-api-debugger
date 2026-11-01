import { Prisma } from '@prisma/client';
import type { UsageSqlReader } from './sqlite-read-snapshot';

export type UsageNameRow = { id: string; name: string | null };
export interface UsageDb {
  $queryRaw<T = unknown>(query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]): Promise<T>;
  projectNames(ids: readonly string[]): Promise<UsageNameRow[]>;
  userNames(ids: readonly string[]): Promise<UsageNameRow[]>;
  requestTasks(ids: readonly string[]): Promise<Array<{ id: string; task_id: string | null }>>;
}
export type UsageDbSource = UsageDb | Prisma.TransactionClient;

/** Keep the caller's actual Prisma permission predicate in its original client. */
export function usageDatabase(source: UsageDbSource, projectWhere?: Prisma.ProjectWhereInput): UsageDb {
  if ('projectNames' in source) return source;
  return {
    $queryRaw: (query, ...values) => source.$queryRaw(query, ...values),
    projectNames: ids => source.project.findMany({ where: { AND: [{ id: { in: [...ids] } }, projectWhere || {}] }, select: { id: true, name: true }, take: 500 }),
    userNames: ids => source.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
    requestTasks: ids => source.providerApiRequest.findMany({ where: { id: { in: [...ids] } }, select: { id: true, task_id: true } }),
  };
}

/** Only the three management ID projections belong to this read adapter. */
export function usageReaderDatabase(reader: UsageSqlReader): UsageDb {
  return {
    async $queryRaw<T = unknown>(query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]): Promise<T> {
      const statement = Array.isArray(query) ? Prisma.sql(query as TemplateStringsArray, ...values) : query as Prisma.Sql;
      return await reader.query(statement) as T;
    },
    projectNames: ids => ids.length ? reader.query<UsageNameRow>(Prisma.sql`SELECT "id", "name" FROM "Project" WHERE "id" IN (${Prisma.join([...ids])}) LIMIT 500`) : Promise.resolve([]),
    userNames: ids => ids.length ? reader.query<UsageNameRow>(Prisma.sql`SELECT "id", "name" FROM "User" WHERE "id" IN (${Prisma.join([...ids])})`) : Promise.resolve([]),
    requestTasks: ids => ids.length ? reader.query<{ id: string; task_id: string | null }>(Prisma.sql`SELECT "id", "task_id" FROM "ProviderApiRequest" WHERE "id" IN (${Prisma.join([...ids])})`) : Promise.resolve([]),
  };
}

/** Explicit DateTime projections only; JSON numeric/text values never pass here. */
export function usageDateTime(value: string | number | bigint | Date | boolean | null): Date | typeof value {
  if (value === null || value instanceof Date || typeof value === 'boolean') return value;
  // SQLite CURRENT_TIMESTAMP's exact default text is UTC in Prisma as well.
  // Keep JSON text outside this decoder; do not broaden this to guessed formats.
  let input: string | number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) input = `${value.replace(' ', 'T')}Z`;
    else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Invalid usage DateTime text');
  }
  const date = new Date(input);
  if (typeof value === 'string' && !Number.isFinite(date.getTime())) throw new Error('Invalid usage DateTime text');
  return Number.isFinite(date.getTime()) ? date : value;
}
