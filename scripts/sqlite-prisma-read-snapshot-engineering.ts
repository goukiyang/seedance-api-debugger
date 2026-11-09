import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { sqliteClient } from '../src/lib/sqlite-client';
import { withSqlitePrismaReadSnapshot } from '../src/lib/sqlite-prisma-read-snapshot';

async function main() {
  const root = process.cwd(), startedAt = new Date().toISOString();
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'sqlite-read-delegates-'));
  process.env.DATABASE_URL = `file:${directory}/synthetic.db`;
  const db = sqliteClient(new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [], errorFormat: 'minimal' }));
  const checks: string[] = [];
  const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const timestamp = new Date('2026-11-01T12:34:56.789Z');
  const names = ['PlatformSetting', 'User', 'Project', 'ProjectMember', 'Asset', 'ImageStudioPreset', 'ImageStudioModule', 'ImageStudioTask', 'ContentReaction'];
  const modelOf = (name: string) => Prisma.dmmf.datamodel.models.find(model => model.name === name)!;
  async function insert(name: string, supplied: Record<string, unknown>) {
    const model = modelOf(name), fields = model.fields.filter(field => field.kind !== 'object');
    const data = fields.map(field => field.name in supplied ? supplied[field.name] : !field.isRequired ? null
      : field.type === 'DateTime' ? timestamp : field.type === 'Boolean' ? false : ['Int', 'Float', 'BigInt'].includes(field.type) ? 0 : '');
    await db.$executeRawUnsafe(`INSERT INTO ${quote(model.dbName || name)} (${fields.map(field => quote(field.dbName || field.name)).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...data);
  }
  try {
    for (const name of names) {
      const model = modelOf(name);
      await db.$executeRawUnsafe(`CREATE TABLE ${quote(model.dbName || name)} (${model.fields.filter(field => field.kind !== 'object').map(field =>
        `${quote(field.dbName || field.name)} ${field.type === 'DateTime' ? 'DATETIME' : ['Int', 'BigInt', 'Boolean'].includes(field.type) ? 'INTEGER' : field.type === 'Float' ? 'REAL' : 'TEXT'}`).join(',')})`);
    }
    await db.$executeRawUnsafe('CREATE TABLE Probe (id INTEGER PRIMARY KEY, value TEXT)');
    await db.$executeRawUnsafe("INSERT INTO Probe VALUES (1,'before')");
    await insert('User', { id: 'owner', name: 'Owner', role: 'admin', status: 'active', account_type: 'company' });
    await insert('User', { id: 'member', name: 'Member', role: 'user', status: 'active', account_type: 'company' });
    await insert('Project', { id: 'project', owner_user_id: 'owner', type: 'shared', status: 'active' });
    await insert('ProjectMember', { id: 'membership', project_id: 'project', user_id: 'member', role: 'member', status: 'active' });
    await insert('PlatformSetting', { id: 'one', key: 'studio_style_group_v1:Mixed_CASE%_01', value_json: '{}' });
    await insert('PlatformSetting', { id: 'two', key: 'studio_style_group_v1:lower', value_json: '{"a":1}' });
    await insert('PlatformSetting', { id: 'three', key: 'ordinary', value_json: '{}' });
    await insert('ImageStudioPreset', { id: 'shared', owner_id: 'owner', is_shared: true });
    await insert('ImageStudioPreset', { id: 'private', owner_id: 'owner', is_shared: false });
    await insert('ImageStudioTask', { id: 'one-task', owner_id: 'owner', module_id: 'module', batch_id: 'batch', status: 'completed' });
    await insert('ImageStudioTask', { id: 'two-task', owner_id: 'member', module_id: 'other-module', batch_id: 'batch-two', status: 'failed' });
    await insert('ContentReaction', { id: 'like-one', user_id: 'owner', content_key: 'image_template:shared', liked: true, favorited: false });
    await insert('ContentReaction', { id: 'like-two', user_id: 'member', content_key: 'image_template:shared', liked: true, favorited: true });
    const compare = async (name: string, read: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const expected = await read(db), actual = await withSqlitePrismaReadSnapshot(read);
      assert.deepEqual(actual, expected, name); checks.push(name);
    };
    await compare('scalars_dates_booleans_null_and_projection', tx => tx.imageStudioPreset.findMany({ where: { OR: [{ owner_id: 'member' }, { is_shared: true }] }, select: { id: true, is_shared: true, updated_at: true, banner_asset_id: true }, orderBy: { id: 'asc' } }));
    await compare('namespace_like_semantics_match_prisma', tx => tx.platformSetting.findMany({ where: { key: { startsWith: 'studio_style_group_v1:mixed_case%_' } }, select: { id: true, key: true }, orderBy: { key: 'asc' } }));
    await compare('nested_boolean_empty_in_and_null_filters', tx => tx.imageStudioTask.findMany({ where: { AND: [{ id: { notIn: [] } }, { OR: [{ status: { in: ['completed'] } }, { id: { in: [] } }] }, { NOT: [{ deleted_at: { not: null } }] }] }, select: { id: true, owner_id: true } }));
    await compare('relation_some_and_nested_select', tx => tx.project.findMany({ where: { members: { some: { user_id: 'member', status: 'active' } } }, select: { id: true, owner: { select: { id: true, role: true } }, members: { where: { user_id: 'member' }, select: { user_id: true, role: true } } } }));
    await compare('relation_every_none_and_parent_null', tx => tx.project.findMany({ where: { members: { every: { status: 'active' }, none: { user_id: 'blocked' } }, owner: { is: { status: 'active' } } }, select: { id: true } }));
    await compare('include_preserves_scalar_result_and_related_rows', tx => tx.project.findFirst({ where: { id: 'project' }, include: { owner: { select: { id: true, name: true } }, members: true } }));
    await compare('count_and_grouped_counts_match_prisma', tx => tx.contentReaction.groupBy({ by: ['content_key'], where: { liked: true }, _count: { _all: true } }));
    await compare('count_select_matches_prisma', tx => tx.imageStudioTask.count({ where: { owner_id: 'owner' }, select: { _all: true, module_id: true } }));
    await compare('raw_parameterized_sql_and_bigints', tx => tx.$queryRaw(Prisma.sql`SELECT id, count(*) AS total FROM ImageStudioTask WHERE owner_id=${'owner'} GROUP BY id`));
    await compare('findUniqueOrThrow_and_Date_filter_match_prisma', tx => tx.platformSetting.findUniqueOrThrow({ where: { key: 'ordinary', updated_at: timestamp }, select: { id: true, updated_at: true } }));
    await withSqlitePrismaReadSnapshot(async tx => {
      const before = await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM Probe WHERE id=1`;
      assert.equal(before[0].value, 'before');
      await db.$executeRawUnsafe("UPDATE Probe SET value='after' WHERE id=1");
      assert.deepEqual(await tx.$queryRaw`SELECT value FROM Probe WHERE id=1`, before);
      assert.equal((await tx.imageStudioPreset.findUnique({ where: { id: 'shared' }, select: { is_shared: true } }))?.is_shared, true);
      await db.$executeRawUnsafe("UPDATE ImageStudioPreset SET is_shared=0 WHERE id='shared'");
      assert.equal((await tx.imageStudioPreset.findUnique({ where: { id: 'shared' }, select: { is_shared: true } }))?.is_shared, true);
    });
    assert.equal((await withSqlitePrismaReadSnapshot(tx => tx.imageStudioPreset.findUnique({ where: { id: 'shared' }, select: { is_shared: true } })))?.is_shared, false);
    checks.push('writer_commits_during_pinned_snapshot_and_next_snapshot_observes_revocation');
    await assert.rejects(withSqlitePrismaReadSnapshot(tx => tx.$queryRawUnsafe("UPDATE Probe SET value='forbidden' WHERE id=1 RETURNING value")), error => (error as { code?: string }).code === 'USAGE_READ_SQLITE');
    await assert.rejects(withSqlitePrismaReadSnapshot(tx => tx.platformSetting.create({ data: { key: 'forbidden', value_json: '{}' } })), /sqlite_snapshot_query_unsupported/);
    await assert.rejects(withSqlitePrismaReadSnapshot(tx => tx.$executeRawUnsafe("UPDATE Probe SET value='forbidden' WHERE id=1")), /sqlite_snapshot_query_unsupported/);
    assert.deepEqual(await withSqlitePrismaReadSnapshot(tx => tx.$queryRaw`SELECT value FROM Probe WHERE id=1`), [{ value: 'after' }]);
    checks.push('raw_returning_and_delegate_writes_are_rejected_without_data_change');
    const sources = ['src/lib/sqlite-prisma-read-snapshot.ts', 'src/lib/usage/sqlite-read-snapshot.ts', 'scripts/usage-sqlite-reader.py', 'src/lib/image-studio/read-snapshot.ts'];
    const sha = (file: string) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'sqlite-prisma-read-snapshot-engineering.v1', synthetic: true,
      runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID(), startedAt, finishedAt: new Date().toISOString(), completed: true,
      checks, prismaVersion: Prisma.prismaVersion.client, sourceSha256: Object.fromEntries(sources.map(file => [file, sha(file)])),
      fixtureSha256: sha('scripts/sqlite-prisma-read-snapshot-engineering.ts'), productionWrites: 0, paidRequests: 0, browserRuns: 0 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`SQLite read delegate engineering receipt: ${receipt}`);
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
