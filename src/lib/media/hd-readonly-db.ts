import { PrismaClient } from '@prisma/client';

const globalHd = globalThis as unknown as { hdReadonlyDb?: ReturnType<typeof createClient> };
function createClient() {
  // Do not import the application's client: its startup configures SQLite pragmas.
  return new PrismaClient({ log: [] }).$extends({ query: { $allOperations({ operation, args, query }) {
    if (!['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) throw new Error('hd_readonly_query_required');
    return query(args);
  } } });
}
export const hdReadonlyDb = globalHd.hdReadonlyDb || createClient();
globalHd.hdReadonlyDb = hdReadonlyDb;
