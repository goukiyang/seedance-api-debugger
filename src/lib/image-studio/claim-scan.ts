import type { Prisma } from '@prisma/client';

export const STUDIO_CLAIM_SCAN_LIMIT = 32;
const KEY = 'studio_task_claim_scan_v1';
type Position = { at: string; id: string };
type Sweep = { version: 1; cursor: Position | null; ceiling: Position };
type Db = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioTask'>;
const position = (row: { created_at: Date; id: string }): Position => ({ at: row.created_at.toISOString(), id: row.id });
function parse(value: string): Sweep {
  const state = JSON.parse(value) as Sweep;
  const valid = (p: Position) => p && typeof p.id === 'string' && p.id.length <= 160 && Number.isFinite(Date.parse(p.at));
  if (state.version !== 1 || !valid(state.ceiling) || state.cursor !== null && !valid(state.cursor)) throw new Error('invalid_studio_claim_scan');
  return state;
}

/** A durable tuple, not a mutable/deleted cursor row. A fixed ceiling prevents tail starvation. */
export async function studioClaimScanPage(db: Db, eligible: Prisma.ImageStudioTaskWhereInput) {
  const stored = await db.platformSetting.findUnique({ where: { key: KEY }, select: { value_json: true } });
  let state = stored ? parse(stored.value_json) : null;
  if (!state) {
    const last = await db.imageStudioTask.findFirst({ where: eligible, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { id: true, created_at: true } });
    if (!last) return { rows: [], advance: async () => {} };
    state = { version: 1, cursor: null, ceiling: position(last) };
  }
  const sweep = state;
  const bounds: Prisma.ImageStudioTaskWhereInput[] = [{ OR: [
    { created_at: { lt: new Date(sweep.ceiling.at) } }, { created_at: new Date(sweep.ceiling.at), id: { lte: sweep.ceiling.id } },
  ] }];
  if (sweep.cursor) bounds.push({ OR: [
    { created_at: { gt: new Date(sweep.cursor.at) } }, { created_at: new Date(sweep.cursor.at), id: { gt: sweep.cursor.id } },
  ] });
  const rows = await db.imageStudioTask.findMany({ where: { AND: [eligible, ...bounds] },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: STUDIO_CLAIM_SCAN_LIMIT });
  return { rows, advance: async (last?: { created_at: Date; id: string }) => {
    // Do not skip the unused suffix when a candidate was found early.
    const finished = !last || rows.length < STUDIO_CLAIM_SCAN_LIMIT && last.id === rows.at(-1)?.id;
    if (finished) {
      if (stored) await db.platformSetting.deleteMany({ where: { key: KEY, value_json: stored.value_json } });
      return;
    }
    const next = JSON.stringify({ ...sweep, cursor: position(last) });
    if (stored) await db.platformSetting.updateMany({ where: { key: KEY, value_json: stored.value_json }, data: { value_json: next } });
    else {
      try { await db.platformSetting.create({ data: { key: KEY, value_json: next } }); }
      catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
    }
  } };
}
