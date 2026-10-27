import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertReadonlyDatabaseMount } from './readonly-mount';
import { hdReadLimit, hdReadUrls, hdReadWindow, type HdReadAsset, type HdDatedAsset, type HdReadReference, type HdReadRepository, type HdReadTask } from '../media/hd-read-repository';
import { studioTaskStates } from '../image-studio/pricing-state';

type Row = Record<string, unknown>;
type ReadHandle = { prepare(sql: string): { all(...values: (string | number | null)[]): Row[] }; close(): void };
type SqliteNative = { DatabaseSync: new (file: string, options: { readOnly: true }) => ReadHandle };
const text = (value: unknown) => { if (typeof value !== 'string') throw new Error('hd_read_row_invalid'); return value; };
const nullable = (value: unknown) => value === null ? null : text(value);
export function hdReadDate(value: unknown): Date {
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') throw new Error('hd_read_date_invalid');
  let normalized: string | number = typeof value === 'bigint' ? Number(value) : value;
  // Match Prisma SQLite's UTC timestamps, including legacy SQL datetime text.
  if (typeof normalized === 'string') {
    const iso = /^(\d{4}-\d\d-\d\d)[Tt ](\d\d):(\d\d):(\d\d)/.exec(normalized);
    if (iso) {
      const calendar = new Date(iso[1] + 'T00:00:00Z');
      if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== iso[1]
        || Number(iso[2]) > 23 || Number(iso[3]) > 59 || Number(iso[4]) > 59) throw new Error('hd_read_date_invalid');
    }
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(normalized)) normalized = normalized.replace(' ', 'T') + 'Z';
    else if (/^\d{4}-\d\d-\d\d[Tt ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(normalized)) normalized = normalized.replace(' ', 'T');
    else if (!/^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d\d:\d\d:\d\d\s+(?:[+-]\d{4}|UT|GMT|[ECMP][SD]T)$/.test(normalized)) throw new Error('hd_read_date_invalid');
  }
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error('hd_read_date_invalid');
  return date;
}
const assetColumns = 'a.id, a.owner_id, a.original_url, a.metadata_json, a.status, a.type';
const datedAssetColumns = assetColumns + ', a.created_at';
const referenceColumns = 'r.id, r.owner_user_id, r.url, r.status, r.asset_id, b.status AS album_status';
const referenceJoin = 'FROM ReferenceImage r JOIN ReferenceAlbum b ON b.id=r.album_id';
const asset = (row: Row): HdReadAsset => ({ id: text(row.id), owner_id: text(row.owner_id), original_url: text(row.original_url),
  metadata_json: nullable(row.metadata_json), status: text(row.status), type: text(row.type) });
const datedAsset = (row: Row): HdDatedAsset => ({ ...asset(row), created_at: hdReadDate(row.created_at) });
const reference = (row: Row): HdReadReference => ({ id: text(row.id), owner_user_id: text(row.owner_user_id), url: text(row.url),
  status: text(row.status), asset_id: nullable(row.asset_id), album: { status: text(row.album_status) } });
const task = (row: Row): HdReadTask => ({ id: text(row.id), owner_id: text(row.owner_id), status: text(row.status),
  usage_json: nullable(row.usage_json), asset_id: nullable(row.asset_id), finished_at: row.finished_at === null ? null : hdReadDate(row.finished_at) });

export function assertReadonlySqliteRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  // Node 22.11 accepted unknown constructor options but had no readOnly support.
  // Accept the verified 22.x implementation and newer LTS API family only.
  if (!match || !(Number(match[1]) === 22 && Number(match[2]) >= 12 || Number(match[1]) >= 24)) throw new Error('readonly_sqlite_runtime_required');
}

export function openReadonlyHdRepository(file: string): HdReadRepository {
  assertReadonlySqliteRuntime();
  if (!path.isAbsolute(file) || file.includes('\0') || file.includes('?')) throw new Error('readonly_database_path_invalid');
  if (process.env.NODE_ENV === 'production') {
    if (process.platform !== 'linux') throw new Error('readonly_database_linux_required');
    file = fs.realpathSync(file);
    const sidecars = ['-wal', '-shm', '-journal'].map(suffix => file + suffix).filter(name => fs.existsSync(name)).map(name => fs.realpathSync(name));
    assertReadonlyDatabaseMount(file, fs.readFileSync('/proc/self/mountinfo', 'utf8'), sidecars);
  }
  // A builtin-only require avoids pulling a new native driver or Prisma into
  // diagnostic processes. Failure to load/open is fatal, never a writer fallback.
  const sqlite = createRequire(path.join(process.cwd(), 'package.json'))('node:sqlite') as SqliteNative;
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const query = (sql: string, values: (string | number | null)[] = []) => db.prepare(sql).all(...values);
  const first = <T>(rows: T[]) => rows[0] || null;
  const failed = studioTaskStates(['failed', 'uncertain']);
  const candidate = `(t.status = ? OR (t.status IN (${failed.map(() => '?').join(',')}) AND t.asset_id IS NOT NULL AND (t.usage_json LIKE ? OR t.usage_json LIKE ?)))`;
  const candidateValues = ['succeeded', ...failed, '%"generated_dimensions_mismatch"%', '%"generated_format_mismatch"%'];
  return Object.freeze({
    assetById: async (id: string) => first(query(`SELECT ${assetColumns} FROM Asset a WHERE a.id=? LIMIT 1`, [id]).map(asset)),
    referenceById: async (id: string) => first(query(`SELECT ${referenceColumns} ${referenceJoin} WHERE r.id=? LIMIT 1`, [id]).map(reference)),
    assetsAtUrls: async (input: string[]) => {
      const urls = hdReadUrls(input); if (!urls.length) return [];
      return query(`SELECT ${assetColumns} FROM Asset a WHERE a.original_url IN (${urls.map(() => '?').join(',')}) LIMIT 2`, urls).map(asset);
    },
    referencesAtUrls: async (input: string[]) => {
      const urls = hdReadUrls(input); if (!urls.length) return [];
      return query(`SELECT ${referenceColumns} ${referenceJoin} WHERE r.url IN (${urls.map(() => '?').join(',')}) LIMIT 2`, urls).map(reference);
    },
    nextAssets: async (cursor, captured, take) => {
      const { at, end } = hdReadWindow(cursor, captured);
      return query(`SELECT ${datedAssetColumns} FROM Asset a WHERE a.status=? AND a.type=? AND a.created_at<=?
        AND (a.created_at>? OR (a.created_at=? AND a.id>?)) ORDER BY a.created_at ASC, a.id ASC LIMIT ?`,
      ['active', 'image', end, at, at, cursor.id, hdReadLimit(take)]).map(datedAsset);
    },
    nextTasks: async (cursor, captured, take) => {
      const { at, end } = hdReadWindow(cursor, captured);
      return query(`SELECT t.id, t.owner_id, t.status, t.usage_json, t.finished_at, t.asset_id FROM ImageStudioTask t WHERE ${candidate}
        AND t.deleted_at IS NULL AND t.asset_id IS NOT NULL AND t.finished_at<=? AND (t.finished_at>? OR (t.finished_at=? AND t.id>?))
        ORDER BY t.finished_at ASC, t.id ASC LIMIT ?`, [...candidateValues, end, at, at, cursor.id, hdReadLimit(take)]).map(task);
    },
    taskAsset: async (id: string, ownerId: string) => first(query(`SELECT ${assetColumns} FROM Asset a WHERE a.id=? AND a.owner_id=? AND a.status=? AND a.type=? LIMIT 1`,
      [id, ownerId, 'active', 'image']).map(asset)),
    countActiveImageAssets: async () => {
      const count = Number(query('SELECT COUNT(*) AS count FROM Asset WHERE status=? AND type=?', ['active', 'image'])[0].count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('hd_read_count_invalid'); return count;
    },
    inventoryAssets: async () => query(`SELECT ${datedAssetColumns} FROM Asset a WHERE a.status=? AND a.type=?
      AND EXISTS(SELECT 1 FROM User u WHERE u.id=a.owner_id AND u.status=?) ORDER BY a.created_at ASC, a.id ASC`, ['active', 'image', 'active']).map(datedAsset),
    inventoryReferences: async () => query(`SELECT ${referenceColumns} ${referenceJoin} WHERE r.status=? AND r.asset_id IS NULL AND b.status=?
      AND EXISTS(SELECT 1 FROM User u WHERE u.id=r.owner_user_id AND u.status=?) ORDER BY r.created_at ASC, r.id ASC`, ['active', 'active', 'active']).map(reference),
    close: async () => { db.close(); },
  } satisfies HdReadRepository);
}
