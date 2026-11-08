import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import os from 'node:os';
import { WORKS_CHECKS, WORKS_SOURCES } from './works-fixture-inputs.mjs';
import { WorkMediaScheduler } from './works-consumer-scheduler';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function main() {
  const root = realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID || randomUUID();
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'works-'));
  const databaseDirectory = mkdtempSync(path.join(os.tmpdir(), 'works-synthetic-'));
  const databasePath = path.join(databaseDirectory, 'synthetic.db');
  const sourceSha256 = Object.fromEntries(WORKS_SOURCES.map((file: string) => [file, hash(readFileSync(path.join(root, file)))]));
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${databasePath}`, SESSION_SECRET: 'synthetic-works-fixture',
    FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  const baselineSchema = path.join(root, 'scripts/fixtures/works-baseline-0.128.0.prisma');
  assert.equal(hash(readFileSync(baselineSchema)), '863cf45415fa3a492848836ed8173ecf65a8b613e003dd21c5c0fa8a6c16f648');
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', baselineSchema], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const migrationProof = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3, sys, json, re
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; db.execute('PRAGMA foreign_keys=ON')
sql=open(sys.argv[2]).read()
assert not re.search(r'^\\s*(DROP|DELETE|UPDATE|REPLACE|INSERT)\\s',sql,re.I|re.M)
tables={r['name']:r['sql'] for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
columns={name:[tuple(r) for r in db.execute('PRAGMA table_info("'+name+'")')] for name in tables}
assert all(not name.startswith('Work') or name=='Workspace' or name=='WorkspaceAsset' for name in tables)
assert 'work_audience' not in [r[1] for r in columns['Project']]
db.execute("INSERT INTO User(id,name,username,email,password_hash,updated_at) VALUES('legacy-owner','Legacy','legacy-fixture','legacy@example.invalid','synthetic',CURRENT_TIMESTAMP)")
db.execute("INSERT INTO Project(id,name,type,visibility,owner_user_id,created_by,description,updated_at) VALUES('legacy-project','Legacy project','team','private','legacy-owner','legacy-owner','unchanged',CURRENT_TIMESTAMP)")
db.execute("INSERT INTO PlatformSetting(id,key,value_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)",('legacy-receipt','legacy-request-receipt',json.dumps({'state':'unknown','requestId':'original-request'})))
before={table:[dict(r) for r in db.execute('SELECT * FROM "'+table+'" ORDER BY id')] for table in ['User','Project','PlatformSetting']}
indexes={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
db.commit(); db.executescript('BEGIN IMMEDIATE;\\n'+sql+'\\nCOMMIT;')
after_tables={r['name']:r['sql'] for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
expected={'Work','WorkMediaVersion','WorkSourcePolicy','WorkRegistrationJob','WorkDiscoveryCheckpoint','WorkPersonalState','WorkCollection','WorkCollectionItem','WorkOperation'}
assert set(after_tables)-set(tables)==expected
for name in tables:
    after=[tuple(r) for r in db.execute('PRAGMA table_info("'+name+'")')]
    if name=='Project':
        assert after[:-1]==columns[name] and after[-1][1:5]==('work_audience','TEXT',0,None)
    else: assert after==columns[name] and after_tables[name]==tables[name]
for table in before:
    rows=[dict(r) for r in db.execute('SELECT * FROM "'+table+'" ORDER BY id')]
    if table=='Project':
        for row in rows: assert row.pop('work_audience') is None
    assert rows==before[table]
assert indexes <= {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
print(json.dumps({'newTables':len(expected),'oldTablesPreserved':len(tables),'oldRowsPreserved':sum(map(len,before.values())),'projectNullableColumnAdded':True}))
db.close()
`, databasePath, path.join(root, 'prisma/migrations/20261102_team_works_catalog/migration.sql')], { env, encoding: 'utf8', timeout: 30000 }));
  const learningMigrationProof = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3, sys, json, re
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
sql=open(sys.argv[2]).read()
assert not re.search(r'^\\s*(ALTER|DROP|DELETE|UPDATE|REPLACE|INSERT)\\s',sql,re.I|re.M)
before={r['name']:r['sql'] for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
rows={t:[dict(r) for r in db.execute('SELECT * FROM "'+t+'" ORDER BY id')] for t in ['User','Project','PlatformSetting','WorkOperation']}
indexes={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
db.executescript('BEGIN IMMEDIATE;\\n'+sql+'\\nCOMMIT;')
after={r['name']:r['sql'] for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
expected={'WorkContext','WorkSourceLink','WorkLearningEntry','WorkDerivedLink'}
assert set(after)-set(before)==expected
assert all(after[t]==ddl for t,ddl in before.items())
for t,values in rows.items(): assert values==[dict(r) for r in db.execute('SELECT * FROM "'+t+'" ORDER BY id')]
assert indexes <= {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print(json.dumps({'newTables':sorted(expected),'oldTablesPreserved':len(before),'oldRowsPreserved':sum(map(len,rows.values())),'newIndexes':len({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}-indexes)}))
`, databasePath, path.join(root, 'prisma/migrations/20261103_works_learning/migration.sql')], { env, encoding: 'utf8', timeout: 30000 }));
  execFileSync('python3', ['-c', `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executescript(open(sys.argv[2]).read())
    plan = list(db.execute("""EXPLAIN QUERY PLAN SELECT count(*) FROM WorkOperation
        WHERE (CASE WHEN json_valid(result_json) THEN json_extract(result_json,'$.kind') END) IN ('image-template','video-template')
        AND (CASE WHEN json_valid(result_json) THEN json_extract(result_json,'$.workId') END) IN (?)""", ('synthetic',)))
    assert any('SEARCH WorkOperation USING INDEX WorkOperation_successful_method_work_idx' in row[3] for row in plan), plan
`, databasePath, path.join(root, 'prisma/migrations/20261104_works_activity_trial/migration.sql')], { env, timeout: 30000 });
  execFileSync('python3', ['-c', `
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executescript(open(sys.argv[2]).read())
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
`, databasePath, path.join(root, 'prisma/migrations/20261108_works_recommendation/migration.sql')], { env, timeout: 30000 });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const { PrismaClient } = await import('@prisma/client');
  const database = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  const statements: Array<{ query: string; params: string }> = [];
  database.$on('query', event => statements.push({ query: event.query, params: event.params }));
  Reflect.set(globalThis, 'prisma', database); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  let forbiddenCalls = 0, completed = false;
  const forbidden = () => { forbiddenCalls++; throw new Error('Works engineering cannot use network, providers or application services'); };
  mock.method(globalThis, 'fetch', forbidden); mock.method(http, 'request', forbidden); mock.method(http, 'get', forbidden);
  mock.method(https, 'request', forbidden); mock.method(https, 'get', forbidden); mock.method(dns, 'lookup', forbidden);
  const checks: string[] = [], metrics: Record<string, unknown> = { migration: migrationProof, learningMigration: learningMigrationProof };
  try {
    const { getWorkAccess } = await import('../src/lib/works/access');
    const { resolveContent } = await import('../src/lib/content-reactions/content');
    const { readWorkFilters } = await import('../src/lib/works/filters');
    const { readWorkPage, readWorkDetail } = await import('../src/lib/works/query');
    const { recordWorkView, readWorkActivity } = await import('../src/lib/works/activity');
    const { workMediaResponse } = await import('../src/lib/works/media');
    const { mutateWorkLifecycle, addWorkReference, publishUploadedWork } = await import('../src/lib/works/lifecycle');
    const { assertCanViewTask } = await import('../src/lib/projects/permissions');
    const { mutateWorkPersonalState } = await import('../src/lib/works/interactions');
    const { createWorkCollection, addWorkCollectionMembership } = await import('../src/lib/works/collections');
    const { readWorkOperation } = await import('../src/lib/works/operations');
    const { prepareWorkMethod } = await import('../src/lib/works/context-method');
    const { resolveSharedStudioDefinition, getSharedStudioPersonalOverrides } = await import('../src/lib/image-studio/shared-contract');
    const { indexWorkContext } = await import('../src/lib/works/context-index');
    const { readWorkContext } = await import('../src/lib/works/context');
    const { mutateWorkLearning, readWorkLearning } = await import('../src/lib/works/learning');
    const { mutateWorkDerivation, readWorkDerivations } = await import('../src/lib/works/learning-derivations');
    const { requestWorkPreview } = await import('../src/lib/works/preview-request');
    const { processWorksRegistrationPass } = await import('../src/lib/works/ingestion');
    const { setWorksControl, freezeWorkSourcePolicy } = await import('../src/lib/works/source-policy');
    const { canUseWorksPreview, canUseWorksRecommendationTrial } = await import('../src/lib/works/rollout.server');
    const { isNavItemVisible } = await import('../src/lib/navigation');
    const previewActor = { id: 'synthetic-preview-owner', account_type: 'internal' };
    delete process.env.WORKS_PREVIEW_USER_ID;
    assert.equal(canUseWorksPreview(previewActor), false);
    process.env.WORKS_PREVIEW_USER_ID = previewActor.id;
    assert.equal(canUseWorksPreview(previewActor), true);
    assert.equal(canUseWorksPreview(null), false);
    assert.equal(canUseWorksPreview({ ...previewActor, id: 'different-admin' }), false);
    assert.equal(canUseWorksPreview({ ...previewActor, id: previewActor.id + '-suffix' }), false);
    assert.equal(canUseWorksPreview({ ...previewActor, account_type: 'external' }), false);
    const previewNav = { label: '作品广场', href: '/works', externalHidden: true };
    assert.equal(isNavItemVisible(previewNav, true), false);
    assert.equal(isNavItemVisible(previewNav, { role: 'admin', account_type: 'internal' }), false);
    assert.equal(isNavItemVisible(previewNav, { role: 'admin', account_type: 'internal', works_preview: true }), true);
    assert.equal(isNavItemVisible({ label: '资产', href: '/assets' }, { role: 'user', account_type: 'internal' }), true);
    delete process.env.WORKS_PREVIEW_USER_ID;
    const feishuActor = { id: 'synthetic-feishu-colleague', account_type: 'internal',
      feishu: { tenant_key: 'synthetic-tenant', open_id: 'synthetic-feishu-open-id' } };
    assert.equal(canUseWorksPreview(feishuActor), true);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: { tenant_key: 'synthetic-tenant', user_id: 'synthetic-feishu-user-id' } }), true);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: { tenant_key: 'synthetic-tenant', union_id: 'synthetic-feishu-union-id' } }), true);
    assert.equal(canUseWorksPreview({ ...feishuActor, account_type: 'external' }), false);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: { ...feishuActor.feishu, tenant_key: 'different-tenant' } }), false);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: { open_id: 'identity-without-tenant' } }), false);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: { tenant_key: 'synthetic-tenant' } }), false);
    assert.equal(canUseWorksPreview({ ...feishuActor, feishu: null }), false);
    assert.equal(canUseWorksRecommendationTrial(feishuActor), false);
    process.env.WORKS_PREVIEW_USER_ID = previewActor.id;
    assert.equal(canUseWorksRecommendationTrial(previewActor), true);
    assert.equal(canUseWorksPreview(feishuActor), true);
    assert.equal(canUseWorksRecommendationTrial(feishuActor), false);
    delete process.env.WORKS_PREVIEW_USER_ID;
    const { readWorkRecommendationBatch: restrictedRecommendationBatch } = await import('../src/lib/works/recommendation-shadow');
    await assert.rejects(restrictedRecommendationBatch({} as never, feishuActor as never, ''), /restricted to the existing preview account/);
    assert.equal(isNavItemVisible(previewNav, { role: 'user', ...feishuActor, works_preview: canUseWorksPreview(feishuActor) }), true);
    metrics.previewRollout = { internalFeishuEnabled: true, configuredTenantRequired: true, externalDenied: true,
      legacyPreviewRetained: true, recommendationTrialStillExactAccount: true, navigationCapabilityRequired: true };
    const actor = async (id: string, accountType = 'internal', feishu = true, role = 'user') => {
      const user = await database.user.create({ data: { id, name: id === 'owner' ? 'owner@example.invalid' : '同事', username: `fixture-${id}`,
        email: `${id}@example.invalid`, password_hash: 'synthetic-not-a-credential', account_type: accountType, role,
        ...(feishu ? { feishu_user_id: `fixture-${id}`, feishu_tenant_key: 'synthetic-tenant' } : {}) } });
      return { ...user, role: role as 'user' | 'admin', account_type: accountType as 'internal' | 'external', status: 'active' as const };
    };
    const owner = await actor('owner'), colleague = await actor('colleague'), external = await actor('external', 'external');
    const unapproved = await actor('unapproved', 'internal', false), admin = await actor('admin', 'internal', true, 'admin');
    const project = await database.project.create({ data: { id: 'ordinary', name: 'PRIVATE_PROJECT_LABEL', owner_user_id: owner.id, created_by: owner.id, type: 'team', work_audience: 'team' } });
    const createImage = async (suffix: string, audience: 'source' | 'team' | 'project' | 'private' = 'team', completedAt = new Date(Date.now() - 60_000)) => {
      const asset = await database.asset.create({ data: { id: `asset-${suffix}`, owner_id: owner.id, type: 'image', original_url: `/uploads/fixture-${suffix}.png`,
        thumbnail_url: `/uploads/fixture-${suffix}-640.webp`, file_name: 'fixture.png', mime_type: 'image/png', file_size: 64, width: 1200, height: 800, hash: hash(suffix) } });
      const task = await database.imageStudioTask.create({ data: { id: `image-${suffix}`, batch_id: `batch-${suffix}`, owner_id: owner.id,
        ordinal: 1, fingerprint: suffix, prompt: 'PRIVATE_PROMPT_DO_NOT_PROJECT', context: 'PRIVATE_RECIPE_DO_NOT_PROJECT', revision: 1,
        model: 'synthetic', reference_ids: '[]', unit_credits: 0, status: 'succeeded', asset_id: asset.id, finished_at: completedAt } });
      await database.usageAttribution.create({ data: { source_kind: 'image_task', source_id: task.id, actor_user_id: owner.id, owner_user_id: owner.id,
        project_id: project.id, occurred_at: task.created_at, context_origin: 'synthetic' } });
      const policy = audience === 'source' ? null : await database.workSourcePolicy.create({ data: { source_kind: 'image_task', source_id: task.id,
        owner_id: owner.id, project_id: project.id, audience } });
      const work = await database.work.create({ data: { id: `work-${suffix}`, source_kind: 'image_task', source_id: task.id, author_id: owner.id,
        project_id: project.id, title: `作品${suffix}`, medium: 'image', audience, completed_at: completedAt } });
      const media = await database.workMediaVersion.create({ data: { work_id: work.id, source_revision: hash(JSON.stringify([asset.id, asset.hash, asset.original_url])),
        policy_id: policy?.id, asset_id: asset.id, source_url: asset.original_url, source_updated_at: completedAt, content_hash: asset.hash,
        width: asset.width, height: asset.height, thumbnail_url: asset.thumbnail_url, preview_status: 'ready' } });
      await database.work.update({ where: { id: work.id }, data: { current_version_id: media.id } });
      return { work, media, task, asset };
    };
    const current = await createImage('current');
    const access = await getWorkAccess(colleague, current.work.id);
    assert.ok(access?.canPreview); assert.equal(access.canDownload, false); assert.equal(access.reuse, null);
    assert.equal(await getWorkAccess(external, current.work.id), null);
    assert.equal(await getWorkAccess(unapproved, current.work.id), null);
    assert.ok((await getWorkAccess(owner, current.work.id))?.canDownload);
    const first = await readWorkPage(colleague, new URLSearchParams());
    assert.equal(first.items.length, 1); assert.equal(first.items[0].author.name, '同事');
    const view = { viewerId: colleague.id, mediaVersion: current.media.id };
    assert.deepEqual(first.items[0].activity, { views: 0, reuses: 0 });
    assert.deepEqual(await recordWorkView(colleague, current.work.id, view), { views: 1, reuses: 0 });
    assert.deepEqual(await recordWorkView(colleague, current.work.id, view), { views: 1, reuses: 0 });
    await assert.rejects(recordWorkView(external, current.work.id, { ...view, viewerId: external.id }), error => (error as { status?: number }).status === 404);
    await assert.rejects(recordWorkView(colleague, current.work.id, { ...view, mediaVersion: 'old-media-version' }), error => (error as { status?: number }).status === 404);
    assert.deepEqual((await readWorkPage(colleague, new URLSearchParams())).items[0].activity, { views: 1, reuses: 0 });
    assert.equal(first.items[0].project, null); assert.equal(first.items[0].downloadUrl, null); assert.equal(first.items[0].reuse, null);
    assert.ok(!JSON.stringify(first).includes('PRIVATE_')); assert.ok(!JSON.stringify(first).includes('example.invalid'));
    assert.equal(await resolveContent(colleague, `asset:${current.asset.id}`), null, 'A Work-preview grant must not open the legacy Asset reader');
    const authorLookup = await readWorkFilters(colleague, new URLSearchParams({ kind: 'authors' }));
    assert.deepEqual(authorLookup.items.map(item => item.name), ['同事']);
    assert.equal((await readWorkPage(colleague, new URLSearchParams({ q: 'current' }))).items.length, 1);
    assert.equal((await readWorkPage(colleague, new URLSearchParams({ q: 'PRIVATE_PROMPT' }))).items.length, 0);
    assert.equal((await readWorkPage(colleague, new URLSearchParams({ q: '%' }))).items.length, 0);
    assert.equal((await readWorkFilters(colleague, new URLSearchParams({ kind: 'authors', q: '同事' }))).items.length, 1);
    assert.equal((await readWorkFilters(colleague, new URLSearchParams({ kind: 'authors', q: '%' }))).items.length, 0);
    assert.equal((await readWorkFilters(colleague, new URLSearchParams({ kind: 'projects' }))).items.length, 0);
    await assert.rejects(workMediaResponse(new Request(`https://fixture.invalid/api/works/${current.work.id}/media?version=${current.media.id}&variant=download`), colleague, current.work.id), error => (error as { status?: number }).status === 403);
    for (const variant of ['original', 'hd', 'hd-description', 'hd-download']) {
      await assert.rejects(workMediaResponse(new Request(`https://fixture.invalid/api/works/${current.work.id}/media?version=${current.media.id}&variant=${variant}`,
        { headers: { 'X-Image-Accept': 'hd-open-v1' } }), colleague, current.work.id), error => (error as { status?: number }).status === 403);
      await assert.rejects(workMediaResponse(new Request(`https://fixture.invalid/api/works/${current.work.id}/media?version=old-media-version&variant=${variant}`,
        { headers: { 'X-Image-Accept': 'hd-open-v1' } }), owner, current.work.id), error => (error as { status?: number }).status === 409);
    }
    const hdFixture = mkdtempSync(path.join(directory, 'hd-read-'));
    mkdirSync(path.join(hdFixture, 'public/uploads'), { recursive: true }); mkdirSync(path.join(hdFixture, 'hd'), { mode: 0o700 });
    const sharp = (await import('sharp')).default;
    writeFileSync(path.join(hdFixture, 'public/uploads/fixture-current.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#999' } }).png().toBuffer());
    const oldHdRoot = process.env.HD_DERIVATIVES_ROOT;
    try {
      process.chdir(hdFixture); process.env.HD_DERIVATIVES_ROOT = path.join(hdFixture, 'hd');
      const description = await workMediaResponse(new Request(`https://fixture.invalid/api/works/${current.work.id}/media?version=${current.media.id}&variant=hd-description`,
        { headers: { 'X-Image-View-Token': randomUUID(), 'X-Image-Accept': 'hd-open-v1' } }), owner, current.work.id);
      assert.equal(description.status, 200); assert.equal(description.headers.get('X-Work-Media-Version'), current.media.id);
      assert.equal((await description.json()).reason, 'not_registered');
      const unavailableHd = await workMediaResponse(new Request(`https://fixture.invalid/api/works/${current.work.id}/media?version=${current.media.id}&variant=hd`), owner, current.work.id);
      assert.equal(unavailableHd.status, 409);
      assert.deepEqual(readdirSync(path.join(hdFixture, 'hd')), [], 'Work reads must not create HD manifests or scheduler state');
      metrics.hdReads = { previewOnlyDenied: true, oldWorkVersionDenied: true, missingHdReturns409: true, getCreatesJobs: false };
    } finally {
      process.chdir(root);
      if (oldHdRoot === undefined) delete process.env.HD_DERIVATIVES_ROOT; else process.env.HD_DERIVATIVES_ROOT = oldHdRoot;
    }
    const videoTime = new Date(Date.now() - 60_000);
    const video = await database.videoTask.create({ data: { id: 'video-fixture-01', provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video',
      prompt: 'PRIVATE_VIDEO_RECIPE', user_id: owner.id, owner_user_id: owner.id, project_id: project.id, local_status: 'succeeded',
      local_video_path: '/videos/video-fixture-01.mp4', delivery_status: 'succeeded', delivery_completed_at: videoTime } });
    const videoPolicy = await database.workSourcePolicy.create({ data: { source_kind: 'video_task', source_id: video.id, owner_id: owner.id, project_id: project.id, audience: 'team' } });
    const videoWork = await database.work.create({ data: { source_kind: 'video_task', source_id: video.id, author_id: owner.id, project_id: project.id, title: '视频作品', medium: 'video', audience: 'team', completed_at: videoTime } });
    const videoMedia = await database.workMediaVersion.create({ data: { work_id: videoWork.id, source_revision: 'video-v1', policy_id: videoPolicy.id,
      video_task_id: video.id, source_url: video.local_video_path, source_updated_at: videoTime, preview_status: 'pending' } });
    await database.work.update({ where: { id: videoWork.id }, data: { current_version_id: videoMedia.id } });
    assert.ok((await getWorkAccess(colleague, videoWork.id))?.canPreview);
    assert.equal((await getWorkAccess(colleague, videoWork.id))?.canDownload, false);
    await assert.rejects(assertCanViewTask(colleague, video));
    await assert.rejects(workMediaResponse(new Request(`https://fixture.invalid/api/works/${videoWork.id}/media?version=${videoMedia.id}&variant=preview`), colleague, videoWork.id), error => (error as { status?: number }).status === 409);
    const cachedPosterFixture = mkdtempSync(path.join(directory, 'cached-poster-'));
    mkdirSync(path.join(cachedPosterFixture, 'public'), { recursive: true });
    const storedVideos = path.join(cachedPosterFixture, 'stored-videos');
    mkdirSync(path.join(storedVideos, 'thumbnails'), { recursive: true });
    symlinkSync(storedVideos, path.join(cachedPosterFixture, 'public/videos'), 'dir');
    writeFileSync(path.join(storedVideos, 'video-fixture-01.mp4'), Buffer.from('synthetic source'));
    const cachedPoster = path.join(storedVideos, 'thumbnails', video.id + '.jpg');
    writeFileSync(cachedPoster, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).jpeg().toBuffer());
    try {
      process.chdir(cachedPosterFixture);
      const card = await readWorkDetail(colleague, videoWork.id);
      assert.equal(card?.previewStatus, 'not-prepared');
      assert.ok(card?.thumbnailUrl?.includes('cached=1'));
      const request = new Request('https://fixture.invalid' + card!.thumbnailUrl!, { method: 'HEAD' });
      assert.equal((await workMediaResponse(request, colleague, videoWork.id)).headers.get('Content-Type'), 'image/jpeg');
      await assert.rejects(workMediaResponse(request, external, videoWork.id), error => (error as { status?: number }).status === 404);
      utimesSync(cachedPoster, new Date(0), new Date(0));
      await assert.rejects(workMediaResponse(request, colleague, videoWork.id), error => (error as { status?: number }).status === 404);
      assert.equal(await database.workRegistrationJob.count({ where: { source_kind: 'media_preview', source_id: videoMedia.id } }), 0);
    } finally { process.chdir(root); }
    const multiAsset = await database.asset.create({ data: { owner_id: owner.id, type: 'image', original_url: '/uploads/multi-fixture.png', thumbnail_url: '/uploads/multi-fixture-640.webp',
      file_name: 'collage.png', mime_type: 'image/png', file_size: 128, width: 1600, height: 900, hash: hash('multi'), metadata_json: '{"multiviewOutput":{"schema":1}}' } });
    const { DEFAULT_MULTIVIEW_LAYOUT } = await import('../src/lib/video/multiview-contract');
    const multiRecipe = JSON.stringify({ schema: 2, sourceVersion: hash('synthetic-multiview-source'), slots: [0, 1, 2].map(frame => ({ id: `view-${frame}`, frame, name: 'PRIVATE_MULTIVIEW_RECIPE', manual: false })), reserve: [], restoreOrder: [], layout: DEFAULT_MULTIVIEW_LAYOUT });
    const multiRoles = ['thumbnail', 'collage', 'zip', 'frame-view-0', 'frame-view-1', 'frame-view-2'];
    const multiManifest = { schema: 1, sourceVersion: hash('synthetic-multiview-source'), revision: 1, recipeHash: hash(multiRecipe), width: 1600, height: 900, frameCount: 3,
      files: multiRoles.map((role, index) => ({ role, file: `file-${index}.${role === 'zip' ? 'zip' : role === 'thumbnail' ? 'jpg' : 'png'}`,
        mime: role === 'zip' ? 'application/zip' : role === 'thumbnail' ? 'image/jpeg' : 'image/png', bytes: role === 'collage' ? 128 : 64,
        sha256: role === 'collage' ? multiAsset.hash : hash(role), ...(role === 'zip' ? {} : { width: 1600, height: 900 }) })) };
    const multi = await database.multiviewWork.create({ data: { owner_id: owner.id, source_task_id: video.id, project_id: project.id, save_state: 'saved', status: 'ready',
      ready_revision: 1, ready_recipe_json: multiRecipe, ready_manifest_json: JSON.stringify(multiManifest) } });
    const multiMutation = await database.multiviewWorkMutation.create({ data: { actor_id: owner.id, work_id: multi.id, mutation_id: 'synthetic-save', request_hash: hash('synthetic-save'),
      action: 'save', receipt_json: JSON.stringify({ state: 'committed', workId: multi.id, draftRevision: 1, revision: 1, mutationId: 'synthetic-save', action: 'save' }) } });
    await database.platformSetting.create({ data: { key: `multiview_output_registration_v1:receipt:${multi.id}:1`, value_json: JSON.stringify({ schema: 1, state: 'registered', ownerId: owner.id,
      workId: multi.id, readyRevision: 1, mutationRowId: multiMutation.id, mutationId: multiMutation.mutation_id, mutationRequestHash: multiMutation.request_hash,
      outputs: ['collage', 'frame-view-0', 'frame-view-1', 'frame-view-2'].map(role => ({ state: 'registered', role, assetId: multiAsset.id, sha256: role === 'collage' ? multiAsset.hash : hash(role), originalUrl: multiAsset.original_url, thumbnailUrl: multiAsset.thumbnail_url })) }) } });
    const multiPolicy = await database.workSourcePolicy.create({ data: { source_kind: 'multiview_work', source_id: multi.id, operation_id: '1', owner_id: owner.id, project_id: project.id, audience: 'team' } });
    const multiWork = await database.work.create({ data: { source_kind: 'multiview_work', source_id: multi.id, output_role: 'collage', author_id: owner.id, project_id: project.id,
      title: '3D多视图作品', medium: 'image', audience: 'team', completed_at: videoTime } });
    const multiMedia = await database.workMediaVersion.create({ data: { work_id: multiWork.id, source_revision: '1', policy_id: multiPolicy.id, asset_id: multiAsset.id,
      source_url: multiAsset.original_url, content_hash: multiAsset.hash, thumbnail_url: multiAsset.thumbnail_url, preview_status: 'ready' } });
    await database.work.update({ where: { id: multiWork.id }, data: { current_version_id: multiMedia.id } });
    const multiAccess = await getWorkAccess(colleague, multiWork.id); assert.ok(multiAccess?.canPreview); assert.equal(multiAccess.canDownload, false); assert.equal(multiAccess.reuse, null);
    assert.equal(await resolveContent(colleague, `asset:${multiAsset.id}`), null);
    const upload = await database.asset.create({ data: { owner_id: owner.id, type: 'image', original_url: '/uploads/explicit-upload.png', thumbnail_url: '/uploads/explicit-upload-640.webp',
      file_name: 'explicit.png', mime_type: 'image/png', file_size: 64, hash: hash('explicit-upload') } });
    assert.equal(await database.work.count({ where: { source_id: upload.id } }), 0, 'A reference/upload is not automatically cataloged');
    const uploaded = await publishUploadedWork(owner, { viewerId: owner.id, requestId: 'explicit-upload-operation', assetId: upload.id });
    assert.ok((await getWorkAccess(owner, String(uploaded.result.workId)))?.canPreview);
    assert.equal(await getWorkAccess(colleague, String(uploaded.result.workId)), null);
    metrics.sourceMatrix = ['image', 'video', 'multiview-collage', 'explicit-upload'];
    checks.push(WORKS_CHECKS[0]);

    await database.project.update({ where: { id: project.id }, data: { work_audience: 'project' } });
    assert.equal(await getWorkAccess(colleague, current.work.id), null);
    const member = await database.projectMember.create({ data: { project_id: project.id, user_id: colleague.id, joined_by: owner.id, role: 'viewer' } });
    assert.ok((await getWorkAccess(colleague, current.work.id))?.canPreview);
    await database.work.update({ where: { id: videoWork.id }, data: { audience: 'source' } });
    assert.ok((await getWorkAccess(colleague, videoWork.id))?.canPreview);
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'private' } });
    assert.equal(await getWorkAccess(colleague, videoWork.id), null, 'Narrowing the Work audience also limits existing native catalog shares');
    await assertCanViewTask(colleague, video); // The separate legacy source permission is not rewritten.
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'project' } });
    await database.work.update({ where: { id: videoWork.id }, data: { audience: 'team' } });
    await database.projectMember.update({ where: { id: member.id }, data: { status: 'removed' } });
    assert.equal(await getWorkAccess(colleague, current.work.id), null);
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'team' } });
    const old = await createImage('old', 'source'), privateWork = await createImage('private', 'private');
    assert.equal(await getWorkAccess(colleague, old.work.id), null); assert.equal(await getWorkAccess(colleague, privateWork.work.id), null);
    await database.work.update({ where: { id: old.work.id }, data: { audience: 'team' } });
    assert.equal(await getWorkAccess(colleague, old.work.id), null, 'Missing durable policy cannot grant a team audience through SQL NULL');
    await database.work.update({ where: { id: old.work.id }, data: { audience: 'source' } });
    checks.push(WORKS_CHECKS[1]);

    const favorite = await mutateWorkPersonalState(colleague, current.work.id, { viewerId: colleague.id, requestId: 'favorite-operation', action: 'favorite', active: true, expectedVersion: 0, expectedMediaVersion: current.media.id });
    assert.equal(favorite.operation.state, 'committed');
    const group = await createWorkCollection(colleague, { viewerId: colleague.id, requestId: 'collection-operation', name: '本人收藏', expectedRevision: 0 });
    const groupId = String(group.operation.result.collectionId);
    await addWorkCollectionMembership(colleague, groupId, { viewerId: colleague.id, requestId: 'membership-operation', workId: current.work.id,
      expectedRevision: 1, expectedStateVersion: 1, expectedMediaVersion: current.media.id });
    assert.equal(await database.workCollectionItem.count(), 1);
    const beforeExclusion = await database.work.findUniqueOrThrow({ where: { id: current.work.id } });
    const excluded = await mutateWorkLifecycle(owner, current.work.id, { viewerId: owner.id, requestId: 'exclude-operation', action: 'exclude', expectedRevision: beforeExclusion.revision, expectedMediaVersion: current.media.id });
    assert.ok(!(await readWorkPage(colleague, new URLSearchParams())).items.some(item => item.id === current.work.id));
    assert.ok((await readWorkPage(colleague, new URLSearchParams({ scope: 'favorites' }))).items.some(item => item.id === current.work.id));
    await mutateWorkLifecycle(owner, current.work.id, { viewerId: owner.id, requestId: 'restore-discovery-operation', action: 'restore-discovery', expectedRevision: Number(excluded.result.revision), expectedMediaVersion: current.media.id });
    const originalRevision = (await database.work.findUniqueOrThrow({ where: { id: current.work.id } })).revision;
    await assert.rejects(mutateWorkLifecycle(admin, current.work.id, { viewerId: admin.id, requestId: 'admin-cannot-publish', action: 'withdraw', expectedRevision: originalRevision, expectedMediaVersion: current.media.id }));
    const withdrawalInput = { viewerId: owner.id, requestId: 'withdraw-operation', action: 'withdraw' as const, expectedRevision: originalRevision, expectedMediaVersion: current.media.id };
    const withdrawal = await mutateWorkLifecycle(owner, current.work.id, withdrawalInput);
    assert.deepEqual(await mutateWorkLifecycle(owner, current.work.id, withdrawalInput), withdrawal);
    assert.equal(await getWorkAccess(colleague, current.work.id), null);
    assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'favorites' }))).items.length, 0);
    const ownManaged = await readWorkDetail(owner, current.work.id); assert.equal(ownManaged?.withdrawn, true); assert.equal(ownManaged?.previewUrl, null);
    assert.equal(await database.workCollectionItem.count(), 1); assert.equal(await database.contentReaction.count(), 0);
    await mutateWorkLifecycle(owner, current.work.id, { ...withdrawalInput, requestId: 'restore-operation', action: 'restore-sharing', expectedRevision: Number(withdrawal.result.revision) });
    const replacement = await database.workMediaVersion.create({ data: { work_id: current.work.id, source_revision: 'replacement', asset_id: current.asset.id,
      source_url: current.asset.original_url, source_updated_at: current.task.finished_at, content_hash: current.asset.hash, policy_id: (await database.workSourcePolicy.findFirstOrThrow({ where: { source_id: current.task.id } })).id, thumbnail_url: current.asset.thumbnail_url, preview_status: 'ready' } });
    await database.work.update({ where: { id: current.work.id }, data: { current_version_id: replacement.id, revision: { increment: 1 } } });
    await assert.rejects(mutateWorkPersonalState(colleague, current.work.id, { viewerId: colleague.id, requestId: 'stale-version-operation', action: 'like', active: true, expectedVersion: 2, expectedMediaVersion: current.media.id }), error => (error as { status?: number }).status === 409);
    assert.equal((await readWorkOperation(colleague, 'stale-version-operation')).state, 'unknown');
    const reference = await addWorkReference(owner, current.work.id, { viewerId: owner.id, requestId: 'reference-operation', expectedMediaVersion: replacement.id, tabId: 'fixture-tab' });
    assert.equal(reference.state, 'committed'); assert.equal(await database.workspaceAsset.count(), 1);
    assert.deepEqual(await addWorkReference(owner, current.work.id, { viewerId: owner.id, requestId: 'reference-operation', expectedMediaVersion: replacement.id, tabId: 'fixture-tab' }), reference);
    checks.push(WORKS_CHECKS[2]);

    for (let index = 0; index < 5; index++) await createImage(`page-${index}`, 'team', new Date(Date.now() - (index + 2) * 60_000));
    const page1 = await readWorkPage(colleague, new URLSearchParams({ limit: '2' })); assert.equal(page1.items.length, 2); assert.ok(page1.nextCursor);
    const queryStatement = [...statements].reverse().find(item => item.query.includes('FROM Work w') && item.query.includes('ORDER BY w.completed_at'))!;
    const plan = await database.$queryRawUnsafe<Array<{ detail: string }>>('EXPLAIN QUERY PLAN ' + queryStatement.query, ...JSON.parse(queryStatement.params));
    assert.ok(plan.some(row => /Work_discoverable_completed_at_id_idx/.test(row.detail)), 'Keyset query must retain its sort index');
    const page2 = await readWorkPage(colleague, new URLSearchParams({ limit: '2', after: page1.nextCursor!, window: page1.window }));
    assert.equal(new Set([...page1.items, ...page2.items].map(item => item.id)).size, 4); assert.ok(page2.previousCursor);
    const back = await readWorkPage(colleague, new URLSearchParams({ limit: '2', before: page2.previousCursor!, window: page2.window }));
    assert.deepEqual(back.items.map(item => item.id), page1.items.map(item => item.id));
    const anchored = await readWorkPage(colleague, new URLSearchParams({ limit: '2', anchor: page2.items[1].id, window: page1.window }));
    assert.ok(anchored.items.some(item => item.id === page2.items[1].id));
    const newer = await createImage('new-window');
    const oldWindow = await readWorkPage(colleague, new URLSearchParams({ window: page1.window })); assert.ok(!oldWindow.items.some(item => item.id === newer.work.id));
    await assert.rejects(readWorkPage(external, new URLSearchParams({ after: page1.nextCursor! })), error => (error as { status?: number }).status === 409);
    metrics.queryPlan = plan.map(row => row.detail).filter(detail => /Work|ImageStudioTask|VideoTask|MultiviewWork/.test(detail));
    metrics.maximumReturned = Math.max(page1.items.length, page2.items.length, back.items.length, anchored.items.length);
    checks.push(WORKS_CHECKS[3]);

    await setWorksControl('activate-policy');
    const late = await database.imageStudioTask.create({ data: { id: 'late-image', batch_id: 'late-batch', owner_id: owner.id, ordinal: 1, fingerprint: 'late', prompt: 'synthetic', context: '', revision: 1, model: 'synthetic', reference_ids: '[]', unit_credits: 0,
      created_at: new Date(Date.now() - 86400000), updated_at: new Date(Date.now() - 86400000), status: 'queued' } });
    const legacyVideo = await database.videoTask.create({ data: { id: 'legacy-saved-video', provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video', prompt: 'synthetic',
      user_id: owner.id, owner_user_id: owner.id, project_id: project.id, local_status: 'succeeded', local_video_path: '/videos/legacy-saved-video.mp4', delivery_status: 'succeeded',
      delivery_completed_at: videoTime, created_at: new Date(Date.now() - 86400000) } });
    await processWorksRegistrationPass({ pageSize: 12, jobs: 12 });
    await processWorksRegistrationPass({ pageSize: 12, jobs: 12 });
    const legacyWork = await database.work.findFirstOrThrow({ where: { source_kind: 'video_task', source_id: legacyVideo.id } });
    assert.equal(await database.workRegistrationJob.count({ where: { source_kind: 'media_preview', source_id: legacyWork.current_version_id! } }), 0, 'History indexing must not enqueue a bulk video transcode');
    const legacyDetail = await readWorkDetail(owner, legacyWork.id); assert.ok(legacyDetail?.detailPreviewUrl); assert.equal(legacyDetail.previewUrl, null);
    assert.equal(await database.workRegistrationJob.count({ where: { source_kind: 'media_preview', source_id: legacyWork.current_version_id! } }), 0, 'A detail GET must remain read only');
    const previewIntent = { viewerId: owner.id, requestId: 'prepare-legacy-preview', expectedMediaVersion: legacyWork.current_version_id };
    const previewReceipt = await requestWorkPreview(owner, legacyWork.id, previewIntent);
    assert.equal(previewReceipt.result.state, 'preparing');
    assert.deepEqual(await requestWorkPreview(owner, legacyWork.id, previewIntent), previewReceipt);
    assert.equal(await database.workRegistrationJob.count({ where: { source_kind: 'media_preview', source_id: legacyWork.current_version_id! } }), 1, 'Only the explicit original POST queues its own derivative once');
    await setWorksControl('pause');
    await database.imageStudioTask.update({ where: { id: late.id }, data: { status: 'succeeded', asset_id: current.asset.id, finished_at: new Date() } });
    assert.equal((await processWorksRegistrationPass()).state, 'paused');
    assert.equal(await database.work.count({ where: { source_id: late.id } }), 0);
    await setWorksControl('resume');
    await database.$disconnect();
    await processWorksRegistrationPass({ pageSize: 12, jobs: 12 });
    await processWorksRegistrationPass({ pageSize: 12, jobs: 12 });
    assert.equal(await database.work.count({ where: { source_id: late.id } }), 1);
    const durableWork = await database.work.findFirstOrThrow({ where: { source_id: late.id } });
    await database.work.update({ where: { id: durableWork.id }, data: { discoverable: false, withdrawn_at: new Date() } });
    await processWorksRegistrationPass({ pageSize: 12, jobs: 12 });
    const durable = await database.work.findUniqueOrThrow({ where: { id: durableWork.id } }); assert.equal(durable.discoverable, false); assert.ok(durable.withdrawn_at);
    await database.$transaction(async tx => freezeWorkSourcePolicy(tx, { sourceKind: 'image_task', sourceId: 'older-operation', ownerId: owner.id, projectId: project.id, occurredAt: new Date(Date.now() - 86400000) }));
    assert.equal(await database.workSourcePolicy.count({ where: { source_id: 'older-operation' } }), 0);
    const intent = await database.videoCreationIntent.create({ data: { owner_id: owner.id, project_id: project.id, request_id: 'synthetic-new-intent',
      action: 'generate', entry: 'main', payer_kind: 'user', payer_account_id: owner.id, input_hash: 'synthetic', spec_json: '{}', quote_business_hash: 'synthetic' } });
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'project' } });
    await database.$transaction(tx => freezeWorkSourcePolicy(tx, { sourceKind: 'video_intent', sourceId: intent.id, ownerId: owner.id, projectId: project.id, occurredAt: new Date() }));
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'team' } });
    const intentChild = await database.videoTask.create({ data: { provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video', prompt: 'synthetic',
      user_id: owner.id, owner_user_id: owner.id, project_id: project.id, creation_intent_id: intent.id } });
    await database.$transaction(tx => freezeWorkSourcePolicy(tx, { sourceKind: 'video_task', sourceId: intentChild.id, ownerId: owner.id, projectId: project.id, occurredAt: intentChild.created_at }));
    assert.equal((await database.workSourcePolicy.findFirstOrThrow({ where: { source_kind: 'video_task', source_id: intentChild.id } })).audience, 'project');
    await database.$transaction(tx => freezeWorkSourcePolicy(tx, { sourceKind: 'image_batch', sourceId: 'frozen-image-parent', ownerId: owner.id, projectId: project.id, occurredAt: new Date() }));
    const batchChild = await database.imageStudioTask.create({ data: { id: 'frozen-batch-child', batch_id: 'frozen-image-parent', owner_id: owner.id, ordinal: 1, fingerprint: 'frozen-batch',
      prompt: 'synthetic', context: '', revision: 1, model: 'synthetic', reference_ids: '[]', unit_credits: 0 } });
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'private' } });
    await database.$transaction(tx => freezeWorkSourcePolicy(tx, { sourceKind: 'image_task', sourceId: batchChild.id, ownerId: owner.id, projectId: project.id, occurredAt: batchChild.created_at, inheritImageBatch: true }));
    assert.equal((await database.workSourcePolicy.findFirstOrThrow({ where: { source_kind: 'image_task', source_id: batchChild.id } })).audience, 'team');
    await database.project.update({ where: { id: project.id }, data: { work_audience: 'team' } });
    const direct = await database.imageStudioTask.create({ data: { id: 'freeze-direct', batch_id: 'direct-batch', owner_id: owner.id, ordinal: 1, fingerprint: 'direct',
      prompt: 'synthetic', context: '', revision: 1, model: 'synthetic', reference_ids: '[]', unit_credits: 0 } });
    await database.$transaction(tx => freezeWorkSourcePolicy(tx, { sourceKind: 'image_task', sourceId: direct.id, ownerId: owner.id, projectId: project.id, occurredAt: direct.created_at }));
    assert.equal((await database.workSourcePolicy.findFirstOrThrow({ where: { source_kind: 'image_task', source_id: direct.id } })).audience, 'team');
    const prefixStatement = [...statements].reverse().find(item => item.query.includes('SELECT key FROM PlatformSetting WHERE key >='))!;
    assert.ok(prefixStatement);
    const prefixPlan = await database.$queryRawUnsafe<Array<{ detail: string }>>('EXPLAIN QUERY PLAN ' + prefixStatement.query, ...JSON.parse(prefixStatement.params));
    metrics.policyPrefixPlan = prefixPlan.map(row => row.detail);
    assert.ok(prefixPlan.some(row => /SEARCH PlatformSetting USING (?:COVERING )?INDEX PlatformSetting_key_(?:key|idx)/.test(row.detail)));
    checks.push(WORKS_CHECKS[4]);

    const columns = await database.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(Project)'); assert.ok(columns.some(column => column.name === 'work_audience'));
    // Old readers/writers address their existing columns, so added tables/nullable fields do not rewrite their records.
    await database.$executeRawUnsafe('UPDATE Project SET description = ? WHERE id = ?', 'old-writer-description', project.id);
    const oldReader = await database.$queryRawUnsafe<Array<{ id: string; name: string }>>('SELECT id,name,type,visibility FROM Project WHERE id = ?', project.id); assert.equal(oldReader.length, 1);
    const saved = await database.workCollectionItem.count(), receipts = await database.workOperation.count();
    await database.$disconnect(); assert.equal(await database.workCollectionItem.count(), saved); assert.equal(await database.workOperation.count(), receipts);
    assert.equal(await database.asset.count({ where: { id: current.asset.id } }), 1);
    metrics.personalFacts = { memberships: saved, receipts }; checks.push(WORKS_CHECKS[5]);
    const { checkWorkMethodPin } = await import('./works-method-pin-engineering');
    metrics.methodReader = await checkWorkMethodPin(database);
    const scheduler = new WorkMediaScheduler();
    let activeMedia = 0, maximumMedia = 0, yielded = false, cleanupFinished = false;
    let finishCleanup!: () => void, markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const pendingPreview = scheduler.preview(async signal => {
      activeMedia++; maximumMedia = Math.max(maximumMedia, activeMedia); markStarted();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { yielded = true; resolve(); }, { once: true }));
      await cleanup; cleanupFinished = true; activeMedia--;
      return { state: 'yielded' };
    });
    await started;
    assert.deepEqual(await scheduler.preview(async () => ({ state: 'invalid-overlap' })), { state: 'paused' });
    let primaryStarted = false;
    const primarySlot = scheduler.acquireMultiview().then(release => {
      assert.equal(cleanupFinished, true, 'An encoder and lease cleanup must finish before the next heavy preparation');
      primaryStarted = true; activeMedia++; maximumMedia = Math.max(maximumMedia, activeMedia); return release;
    });
    await Promise.resolve(); assert.equal(yielded, true); assert.equal(primaryStarted, false);
    assert.deepEqual(await scheduler.preview(async () => ({ state: 'invalid-priority' })), { state: 'paused' });
    finishCleanup(); await pendingPreview;
    const releasePrimary = await primarySlot;
    assert.deepEqual(await scheduler.preview(async () => ({ state: 'invalid-overlap' })), { state: 'paused' });
    activeMedia--; releasePrimary();
    assert.deepEqual(await scheduler.preview(async () => ({ state: 'ready' })), { state: 'ready' });
    assert.equal(maximumMedia, 1);
    metrics.mediaScheduling = { maximumHeavyMedia: maximumMedia, previewYielded: yielded, cleanupBeforePrimary: cleanupFinished };
    checks.push(WORKS_CHECKS[6]);
    const learningBase = await createImage('learning-base'), learningSibling = await createImage('learning-sibling');
    const opaqueBatch = 'same-submission-synthetic';
    for (const fixture of [learningBase, learningSibling, privateWork]) {
      await database.imageStudioTask.update({ where: { id: fixture.task.id }, data: { batch_id: opaqueBatch,
        snapshot_json: JSON.stringify({ version: 1, batchId: opaqueBatch, inputFingerprint: hash('same-submission-input'), referencePolicy: { primaryIds: [] }, primaryReferenceImages: [], referenceImages: [] }) } });
      await database.$transaction(tx => indexWorkContext(tx, fixture.work, fixture.media.id));
    }
    const discussion = { viewerId: colleague.id, requestId: 'learning-question-original', expectedMediaVersion: learningBase.media.id,
      kind: 'question', parentId: null, body: 'A synthetic question about the public result', timeSeconds: null };
    const question = await mutateWorkLearning(colleague, learningBase.work.id, discussion, 'create');
    assert.deepEqual(await mutateWorkLearning(colleague, learningBase.work.id, discussion, 'create'), question);
    assert.equal(await database.workLearningEntry.count({ where: { work_id: learningBase.work.id } }), 1);
    await assert.rejects(mutateWorkLearning(colleague, learningBase.work.id, { ...discussion, body: 'changed original intent' }, 'create'), error => (error as { status?: number }).status === 409);
    await assert.rejects(mutateWorkLearning(colleague, learningBase.work.id, { ...discussion, requestId: 'learning-experience-denied', kind: 'experience' }, 'create'), error => (error as { status?: number }).status === 403);
    const experience = await mutateWorkLearning(owner, learningBase.work.id, { ...discussion, viewerId: owner.id, requestId: 'learning-author-experience', kind: 'experience', body: 'A voluntary author note' }, 'create');
    assert.equal(experience.operation.state, 'committed');
    await assert.rejects(mutateWorkLearning(owner, learningBase.work.id, { viewerId: owner.id, requestId: 'learning-edit-other-denied', expectedMediaVersion: learningBase.media.id,
      entryId: question.operation.result.entryId, expectedRevision: 1, body: 'cannot edit another author' }, 'edit'), error => (error as { status?: number }).status === 403);
    const answer = await mutateWorkLearning(owner, learningBase.work.id, { viewerId: owner.id, requestId: 'learning-answer-original', expectedMediaVersion: learningBase.media.id,
      kind: 'answer', parentId: question.operation.result.entryId, body: 'A synthetic answer', timeSeconds: null }, 'create');
    assert.equal(answer.operation.state, 'committed');
    const questionPage = await readWorkLearning(colleague, learningBase.work.id, new URLSearchParams({ version: learningBase.media.id }));
    assert.equal(questionPage.items.length, 1); assert.equal(questionPage.experience?.body, 'A voluntary author note');
    await assert.rejects(readWorkLearning(colleague, learningBase.work.id, new URLSearchParams({ version: 'old-unknown-version' })), error => (error as { status?: number }).status === 409);
    const unknownDurationVersion = (await database.work.findUniqueOrThrow({ where: { id: videoWork.id } })).current_version_id!;
    await database.workMediaVersion.update({ where: { id: unknownDurationVersion }, data: { duration: null } });
    await assert.rejects(mutateWorkLearning(owner, videoWork.id, { viewerId: owner.id, requestId: 'unknown-video-time-denied', expectedMediaVersion: unknownDurationVersion,
      kind: 'question', parentId: null, body: 'Unknown duration must not create a fake timestamp', timeSeconds: 1 }, 'create'), error => (error as { status?: number }).status === 400);
    const context = await readWorkContext(colleague, learningBase.work.id, new URLSearchParams({ version: learningBase.media.id }));
    assert.deepEqual(context.groups.find(group => group.id === 'same-submission')?.items.map(item => item.id), [learningSibling.work.id]);
    assert.ok(!JSON.stringify(context).includes('PRIVATE_'));
    await database.workPersonalState.upsert({ where: { owner_id_work_id: { owner_id: colleague.id, work_id: learningSibling.work.id } },
      create: { owner_id: colleague.id, work_id: learningSibling.work.id, hidden: true }, update: { hidden: true } });
    const hiddenContext = await readWorkContext(colleague, learningBase.work.id);
    assert.ok(!hiddenContext.groups.some(group => group.items.some(item => item.id === learningSibling.work.id)));
    const derivationInput = { viewerId: owner.id, requestId: 'learning-derivation-original', expectedMediaVersion: learningBase.media.id,
      derivedWorkId: learningSibling.work.id, expectedDerivedMediaVersion: learningSibling.media.id, expectedRevision: 0 };
    const linked = await mutateWorkDerivation(owner, learningBase.work.id, derivationInput, false);
    assert.deepEqual(await mutateWorkDerivation(owner, learningBase.work.id, derivationInput, false), linked);
    assert.equal(await database.workDerivedLink.count({ where: { source_work_id: learningBase.work.id } }), 1);
    await assert.rejects(mutateWorkDerivation(colleague, learningBase.work.id, { ...derivationInput, viewerId: colleague.id, requestId: 'learning-other-output-denied' }, false), error => (error as { status?: number }).status === 403);
    assert.equal((await readWorkDerivations(owner, learningBase.work.id, new URLSearchParams({ version: learningBase.media.id }))).items.length, 1);
    await database.work.update({ where: { id: learningSibling.work.id }, data: { withdrawn_at: new Date() } });
    assert.equal((await readWorkDerivations(colleague, learningBase.work.id, new URLSearchParams({ version: learningBase.media.id }))).items.length, 0);
    metrics.learning = { sameSubmissionAuthorizedOnly: true, privateFieldsAbsent: true, authorOnlyExperience: true,
      originalReceiptIdempotent: true, exactMediaVersionRequired: true, unknownTimestampDenied: true, derivationOwnerAndVisibilityRequired: true };
    checks.push(WORKS_CHECKS[7]);
    const registrationTime = new Date(Date.now() - 1000);
    const queuedVideo = await database.videoTask.create({ data: { id: 'queued-video-through-bad-history', provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video',
      prompt: 'synthetic', user_id: owner.id, owner_user_id: owner.id, project_id: project.id, local_status: 'succeeded',
      local_video_path: '/videos/queued-video-through-bad-history.mp4', delivery_status: 'succeeded', delivery_completed_at: registrationTime } });
    const queuedRevision = hash(JSON.stringify([queuedVideo.local_video_path, registrationTime.toISOString(), null]));
    await database.workRegistrationJob.create({ data: { source_kind: 'video_task', source_id: queuedVideo.id, source_revision: queuedRevision, source_updated_at: queuedVideo.updated_at } });
    const malformed = await database.videoTask.create({ data: { id: 'synthetic-malformed-history', provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video',
      prompt: 'synthetic', user_id: owner.id, owner_user_id: owner.id, local_status: 'succeeded', local_video_path: '/videos/synthetic-malformed.mp4', delivery_status: 'succeeded', delivery_completed_at: registrationTime } });
    // SQLite legacy values can fail ORM conversion even when the discovery key is valid.
    await database.$executeRawUnsafe('UPDATE VideoTask SET duration = ? WHERE id = ?', 'synthetic-invalid-legacy-integer', malformed.id);
    for (const kind of ['image_task', 'video_task', 'multiview_work']) await database.workDiscoveryCheckpoint.upsert({ where: { source_kind: kind },
      create: { source_kind: kind }, update: { cursor_at: null, cursor_id: null, upper_at: null } });
    const recoveredPass = await processWorksRegistrationPass({ pageSize: 40, jobs: 12 });
    assert.equal(recoveredPass.state, 'processed');
    assert.equal(await database.work.count({ where: { source_kind: 'video_task', source_id: queuedVideo.id } }), 1, 'A bad history row must not starve an already queued video');
    const deferredSource = await database.workRegistrationJob.findFirst({ where: { source_kind: 'video_task', source_id: malformed.id, error_code: 'WORKS_SOURCE_DISCOVERY_DEFERRED' } });
    assert.ok(deferredSource, 'The exact bad source remains in a durable bounded retry job');
    assert.ok((await database.workDiscoveryCheckpoint.findUniqueOrThrow({ where: { source_kind: 'video_task' } })).cursor_id, 'The history page must advance past a malformed source');
    await database.$executeRawUnsafe('UPDATE VideoTask SET duration = ? WHERE id = ?', 5, malformed.id);
    metrics.registrationIsolation = { readyVideoRegistered: true, exactBadSourceDeferred: true, historyPageAdvanced: true };
    checks.push(WORKS_CHECKS[8]);
    const methodImage = await createImage('exact-method-settings');
    const methodPreset = await database.imageStudioPreset.create({ data: { id: randomUUID(), owner_id: owner.id, scope: 'creator', is_shared: true,
      name: 'Synthetic exact image method', model: 'gemini-nano-banana-2.1', quality: 'auto', resolution: '4K', aspect_ratio: '1:1' } });
    const originalDefinition = await resolveSharedStudioDefinition(owner, methodPreset.id, database);
    await database.imageStudioTask.update({ where: { id: methodImage.task.id }, data: { source_preset_id: methodPreset.id, model: 'gpt-image-2', quality: 'medium', aspect_ratio: '16:9',
      snapshot_json: JSON.stringify({ version: 1, resolution: '2K', sourcePresetId: methodPreset.id, sharedSourceRevision: originalDefinition.definition.sourceRevision,
        sharedLive: { protocol: 'shared-live-v1', presetId: methodPreset.id, definitionToken: originalDefinition.definition.intent.definitionToken },
        referencePolicy: { primaryIds: [] }, primaryReferenceImages: [], referenceImages: [] }) } });
    await database.$transaction(tx => indexWorkContext(tx, methodImage.work, methodImage.media.id));
    const { projectWorkProvenance } = await import('../src/lib/works/provenance');
    const imageSource = await database.work.findUniqueOrThrow({ where: { id: methodImage.work.id } });
    const publicOrigin = (await projectWorkProvenance(colleague, [imageSource], database)).get(imageSource.id)!;
    assert.equal(publicOrigin.template?.label, methodPreset.name);
    assert.equal(publicOrigin.template?.reuseVersion, originalDefinition.definition.sourceRevision);
    await database.imageStudioPreset.update({ where: { id: methodPreset.id }, data: { updated_at: new Date(methodPreset.updated_at.getTime() + 1000) } });
    const changedOrigin = (await projectWorkProvenance(colleague, [imageSource], database)).get(imageSource.id)!;
    assert.equal(changedOrigin.template?.label, methodPreset.name);
    assert.equal(changedOrigin.template?.reuseVersion, null, 'A changed template remains linkable but must not advertise exact reuse');
    await database.imageStudioPreset.update({ where: { id: methodPreset.id }, data: { updated_at: methodPreset.updated_at } });
    assert.equal(new URL(publicOrigin.template!.href, 'https://fixture.invalid').searchParams.get('presetId'), methodPreset.id);
    await database.imageStudioPreset.update({ where: { id: methodPreset.id }, data: { is_shared: false, updated_at: methodPreset.updated_at } });
    assert.equal((await projectWorkProvenance(colleague, [imageSource], database)).get(imageSource.id)!.template, null, 'Output visibility must not expose a private template name');
    await database.imageStudioPreset.update({ where: { id: methodPreset.id }, data: { is_shared: true, updated_at: methodPreset.updated_at } });
    const archivedKey = `studio_preset_archived_v1:${methodPreset.id}`;
    await database.platformSetting.create({ data: { key: archivedKey, value_json: '{}' } });
    assert.equal((await projectWorkProvenance(owner, [imageSource], database)).get(imageSource.id)!.template, null, 'An archived source has no template hyperlink');
    await database.platformSetting.delete({ where: { key: archivedKey } });
    const differentVersion = await createImage('same-template-new-version');
    await database.workContext.create({ data: { work_id: differentVersion.work.id, media_version_id: differentVersion.media.id,
      template_module: 'image-preset', template_id: methodPreset.id, template_version: 'other-version' } });
    const relatedVersions = await readWorkContext(colleague, imageSource.id);
    assert.equal(relatedVersions.groups[0]?.id, 'same-template');
    assert.ok(relatedVersions.groups[0]?.items.some(item => item.id === differentVersion.work.id), 'Same-template browsing spans versions without changing method execution pins');
    const moduleCountBefore = await database.imageStudioModule.count();
    const methodInput = { viewerId: owner.id, requestId: 'prepare-exact-image-method', expectedMediaVersion: methodImage.media.id,
      expectedTemplateVersion: originalDefinition.definition.sourceRevision };
    const methodReceipt = await prepareWorkMethod(owner, methodImage.work.id, methodInput);
    assert.deepEqual(await prepareWorkMethod(owner, methodImage.work.id, methodInput), methodReceipt);
    assert.deepEqual((await readWorkActivity(database, [methodImage.work.id])).get(methodImage.work.id), { views: 0, reuses: 1 });
    assert.equal(await database.imageStudioModule.count(), moduleCountBefore + 1);
    assert.deepEqual(await getSharedStudioPersonalOverrides(owner.id, String(methodReceipt.result.moduleId), database),
      { model: 'gpt-image-2', quality: 'medium', resolution: '2K', aspectRatio: '16:9' });
    const template = await database.videoStudioTemplate.create({ data: { owner_user_id: owner.id, name: 'Synthetic exact video method',
      recipe_json: JSON.stringify({ instruction: 'Synthetic template', fields: [], assetSlots: [], defaultParameters: { model: 'do-not-inherit-model', ratio: '1:1', seed: 999, duration: 8, resolution: '1080p' } }) } });
    const methodVideo = await database.videoTask.create({ data: { provider: 'seedance', model: 'dreamina-seedance-2-0-260128', generation_mode: 'all_in_one_reference',
      prompt: 'synthetic', user_id: owner.id, owner_user_id: owner.id, project_id: project.id, local_status: 'succeeded',
      local_video_path: '/videos/exact-method-settings.mp4', delivery_status: 'succeeded', delivery_completed_at: registrationTime,
      ratio: '16:9', duration: 6, resolution: '720p', seed: 123, generate_audio: true, return_last_frame: false, watermark: false, is_draft: false,
      template_studio_snapshot_json: JSON.stringify({ sourceSnapshot: { templateVersion: { templateId: template.id, templateSource: 'studio', sourceRevision: 'studio:1' } } }) } });
    const methodVideoWork = await database.work.create({ data: { source_kind: 'video_task', source_id: methodVideo.id, author_id: owner.id, project_id: project.id,
      title: 'Synthetic exact video method', medium: 'video', completed_at: registrationTime } });
    const methodVideoMedia = await database.workMediaVersion.create({ data: { work_id: methodVideoWork.id, source_revision: 'exact-video-method', video_task_id: methodVideo.id,
      source_url: methodVideo.local_video_path, source_updated_at: registrationTime, duration: 6, preview_status: 'pending' } });
    await database.work.update({ where: { id: methodVideoWork.id }, data: { current_version_id: methodVideoMedia.id } });
    await database.$transaction(tx => indexWorkContext(tx, methodVideoWork, methodVideoMedia.id));
    const videoSource = await database.work.findUniqueOrThrow({ where: { id: methodVideoWork.id } });
    assert.equal((await projectWorkProvenance(owner, [videoSource], database)).get(videoSource.id)!.template?.label, template.name);
    assert.equal((await projectWorkProvenance(colleague, [videoSource], database)).get(videoSource.id)!.template, null, 'Private video template labels remain private');
    const videoMethodInput = { viewerId: owner.id, requestId: 'prepare-exact-video-method', expectedMediaVersion: methodVideoMedia.id, expectedTemplateVersion: 'studio:1' };
    const videoMethodReceipt = await prepareWorkMethod(owner, methodVideoWork.id, videoMethodInput);
    assert.deepEqual(await prepareWorkMethod(owner, methodVideoWork.id, videoMethodInput), videoMethodReceipt);
    assert.deepEqual((await readWorkActivity(database, [methodVideoWork.id])).get(methodVideoWork.id), { views: 0, reuses: 1 });
    const actualDraft = await database.videoStudioDraft.findUniqueOrThrow({ where: { id: String(videoMethodReceipt.result.draftId) } });
    assert.deepEqual(JSON.parse(actualDraft.parameters_json), { provider: 'seedance', model: 'dreamina-seedance-2-0-260128', generationMode: 'all_in_one_reference',
      ratio: '16:9', duration: 6, resolution: '720p', seed: 123, generateAudio: true, returnLastFrame: false, watermark: false, draft: false });
    metrics.methodSettings = { publicSourceLinksChecked: true, privateAndArchivedSourceLabelsAbsent: true, crossVersionSameTemplateBrowsing: true, imageActualOverridesPreserved: true, videoActualParametersPreserved: true, defaultsNotInherited: true, originalRequestIdempotent: true };
    checks.push(WORKS_CHECKS[9]);
    const { processWorkRecommendationTrial, WORKS_RECOMMENDATION_TRIAL_SETTING } = await import('../src/lib/works/recommendation-trial');
    const trialSource = await createImage('recommendation-source'), trialTarget = await createImage('recommendation-target');
    await database.imageStudioTask.update({ where: { id: trialTarget.task.id }, data: {
      reference_ids: JSON.stringify([trialSource.asset.id]),
      snapshot_json: JSON.stringify({ referencePolicy: { primaryIds: [trialSource.asset.id] }, primaryReferenceImages: [{ id: trialSource.asset.id }] }),
    } });
    await database.$transaction(tx => indexWorkContext(tx, trialTarget.work, trialTarget.media.id));
    process.env.WORKS_PREVIEW_USER_ID = owner.id;
    assert.equal(await processWorkRecommendationTrial(() => false), undefined);
    await database.platformSetting.create({ data: { key: WORKS_RECOMMENDATION_TRIAL_SETTING, value_json: 'true' } });
    const runTrial = async () => {
      for (let i = 0; i < 10; i++) if ((await processWorkRecommendationTrial(() => false))?.complete) return;
      assert.fail('Trial checkpoint did not finish the fixture pass');
    };
    const trialScore = () => database.$queryRaw<Array<{ score: number }>>`SELECT score FROM WorkRecommendationTrial WHERE viewer_id = ${owner.id} AND work_id = ${trialSource.work.id}`;
    await runTrial();
    assert.deepEqual((await trialScore()).map(row => Number(row.score)), [8]);
    await runTrial();
    assert.deepEqual((await trialScore()).map(row => Number(row.score)), [8]);
    await database.work.update({ where: { id: trialTarget.work.id }, data: { withdrawn_at: new Date() } });
    await runTrial();
    assert.deepEqual(await trialScore(), []);
    delete process.env.WORKS_PREVIEW_USER_ID;
    checks.push(WORKS_CHECKS[10]);
    checks.push(WORKS_CHECKS[11]);
    const { runRecommendationEngineering } = await import('./works-recommendation-engineering');
    metrics.recommendation = await runRecommendationEngineering(database, owner, colleague, admin, createImage, statements);
    const { runHdDisplayEngineering } = await import('./hd-display-engineering');
    metrics.recommendationHd = await runHdDisplayEngineering();
    checks.push(WORKS_CHECKS[12]);
    assert.deepEqual(checks, WORKS_CHECKS); assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    await database.$disconnect(); mock.restoreAll();
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'works-engineering.v1', runId, startedAt, finishedAt: new Date().toISOString(),
      fixtureSha256: sourceSha256['scripts/works-engineering.ts'], sourceSha256, checks, metrics, completed, forbiddenCalls,
      synthetic: true, productionWrites: 0, paidRequests: 0, browserRuns: 0 }, null, 2), { mode: 0o600 });
    console.log(`Works engineering receipt: ${receipt}`);
  }
}
process.exitCode = 1;
void main().then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
