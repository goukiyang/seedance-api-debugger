import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import type { UsageFact } from '../src/lib/admin/usage-types';
import type { PublicUsageScope, UsageRecordDTO } from '../src/lib/usage/dto';
import type { TaskThumbnailProjectionSource } from '../src/lib/video/task-thumbnail-projection';

type TaskRow = TaskThumbnailProjectionSource & {
  project_id: string | null; owner_user_id: string | null; user_id: string | null; retention_status: string | null;
};
type ProjectRow = { id: string; status: string; type: string; owner_user_id: string;
  members: Array<{ user_id: string; status: string; role: string }> };

async function main() {
  const root = realpathSync(process.cwd());
  const destination = path.resolve(process.argv[2] || '');
  assert.ok(destination.startsWith(path.join(root, '.role-tests') + path.sep));
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Offline media fixture cannot access business services'); };
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file:/nonexistent/usage-video-media-offline.db', FEISHU_ALLOWED_TENANT_KEY: 'fixture' });
  setFixtureDatabase(new Proxy({}, { get: () => forbidden }));
  Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  globalThis.fetch = forbidden;
  const { readUsageMedia } = await import('../src/lib/usage/media');
  const { taskThumbnailProjection } = await import('../src/lib/video/task-thumbnail-projection');
  const checks: string[] = [];
  const user: SessionUser = { id: 'self', name: 'Fixture', username: 'fixture', email: 'fixture@example.invalid', role: 'user',
    account_type: 'internal', user_profile: 'fixture', feature_profile_id: null, status: 'active', expires_at: null,
    feishu: { user_id: 'fixture', open_id: null, union_id: null, tenant_key: 'fixture', employee_no: null, department_ids: [], last_sync_at: null } };
  const self: PublicUsageScope = { kind: 'self', viewerId: user.id };
  const team: PublicUsageScope = { kind: 'project', viewerId: user.id, projectId: 'team' };
  const ownerProject: ProjectRow = { id: 'team', status: 'active', type: 'team', owner_user_id: 'self', members: [] };
  const ready: TaskRow = { id: 'video001', project_id: 'team', owner_user_id: 'self', user_id: 'legacy', retention_status: 'active',
    local_status: 'succeeded', public_video_url: 'https://media.example.invalid/PRIVATE-PUBLIC.mp4?signature=DO_NOT_EXPORT',
    local_video_path: '/videos/PRIVATE-LOCAL.mp4', result_video_url: 'https://provider.example.invalid/PRIVATE-PROVIDER.mp4',
    result_last_frame_url: 'https://provider.example.invalid/PRIVATE-FRAME.jpg', delivery_status: 'succeeded' };
  const fact = (task: TaskRow, patch: Partial<UsageFact> = {}): UsageFact => ({
    sourceKind: 'video_task', sourceId: task.id, parentSourceKind: null, parentSourceId: null, kind: 'video', leaf: true,
    occurredAt: '2026-10-21T07:00:00.000Z', updatedAt: '2026-10-21T07:00:00.000Z',
    ownerUserId: task.owner_user_id || task.user_id, ownerLabel: 'PRIVATE-OWNER', actorUserId: 'PRIVATE-ACTOR', billingSubject: 'user:self',
    projectId: task.project_id, projectLabel: 'PRIVATE-PROJECT', currentOwnerUserId: task.owner_user_id || task.user_id,
    currentProjectId: task.project_id, attribution: 'frozen', attributionDetail: 'PRIVATE-PROOF', model: 'fixture', provider: 'fixture',
    resolution: null, status: task.local_status || 'unknown', retentionStatus: task.retention_status || 'active', outputCount: 1,
    resultReady: true, costStatus: 'confirmed', confirmedCost: [], confirmedCostCnyMicros: null, chargedPoints: '1',
    reservedPoints: '0', releasedPoints: '0', refundedPoints: '0', ledgerIds: [], href: '/admin/PRIVATE', ...patch,
  });
  const metadataFields = ['id', 'project_id', 'owner_user_id', 'user_id', 'retention_status', 'local_status',
    'public_video_url', 'local_video_path', 'result_video_url', 'result_last_frame_url', 'delivery_status'].sort();
  function database(tasks: TaskRow[], projects: ProjectRow[] = [ownerProject], images: Array<{ id: string; asset_id: string }> = []) {
    const calls = { video: 0, projects: [] as string[], raw: 0 };
    const db = {
      videoTask: { findMany: async (args: { where: { id: { in: string[] } }; take: number; select: Record<string, boolean> }) => {
        calls.video++;
        assert.ok(args.where.id.in.length <= 500); assert.equal(args.take, 500);
        assert.deepEqual(Object.keys(args.select).sort(), metadataFields);
        assert.ok(Object.values(args.select).every(value => value === true));
        return tasks.filter(task => args.where.id.in.includes(task.id));
      } },
      project: { findUnique: async (args: { where: { id: string }; include: { members: { where: { user_id: string } } } }) => {
        calls.projects.push(args.where.id);
        assert.equal(args.include.members.where.user_id, user.id);
        return projects.find(project => project.id === args.where.id) || null;
      } },
      $queryRaw: async (sql: Prisma.Sql) => {
        calls.raw++;
        if (sql.sql.includes('SELECT "id" FROM "PlatformSetting"')) return [];
        assert.ok(sql.sql.includes('FROM "ImageStudioTask"'));
        return images.filter(image => sql.values.includes(image.id));
      },
    } as unknown as Prisma.TransactionClient;
    return { db, calls };
  }

  const initial = database([ready]);
  const one = await readUsageMedia(initial.db, user, [fact(ready)], self);
  const original = taskThumbnailProjection(ready);
  assert.deepEqual(one.get('video_task:video001'), { available: 1, media: {
    thumbnailUrl: original.thumbnail_url, videoUrl: original.play_url, downloadUrl: original.download_url,
  } });
  assert.deepEqual(initial.calls.projects, ['team']);
  assert.equal(one.get('video_task:video001')?.media?.imageUrl, undefined);
  checks.push('real_task_projection_with_transaction_project_permission_and_video_type');

  const preparing: TaskRow = { ...ready, id: 'prepare01', public_video_url: null, delivery_status: 'running' };
  const internal: TaskRow = { ...ready, id: 'internal1', public_video_url: null, local_video_path: null,
    result_video_url: 'h3-internal-output://PRIVATE', result_last_frame_url: null, delivery_status: 'pending' };
  const frameOnly: TaskRow = { ...internal, id: 'frame001', result_video_url: null,
    result_last_frame_url: 'https://media.example.invalid/last-frame.jpg' };
  const unavailable: TaskRow = { ...internal, id: 'missing01', result_video_url: null, delivery_status: null };
  const pendingTasks = [preparing, internal, frameOnly, unavailable];
  const pendingDb = database(pendingTasks);
  const pending = await readUsageMedia(pendingDb.db, user, pendingTasks.map(task => fact(task)), self);
  assert.equal(pending.get('video_task:prepare01')?.media?.videoUrl, '/api/video/play/prepare01');
  assert.equal(pending.get('video_task:prepare01')?.media?.downloadUrl, undefined);
  assert.equal(pending.get('video_task:internal1')?.media, undefined);
  assert.equal(pending.get('video_task:internal1')?.available, null);
  assert.equal(pending.get('video_task:frame001')?.media?.thumbnailUrl, '/api/video/thumbnail/frame001');
  assert.equal(pending.get('video_task:frame001')?.media?.videoUrl, undefined);
  assert.equal(pending.get('video_task:missing01')?.available, null);
  assert.equal(pending.get('video_task:missing01')?.media?.downloadUrl, undefined);
  assert.equal(pendingDb.calls.projects.length, 1);
  checks.push('preparing_last_frame_internal_missing_do_not_fabricate_play_or_stable_download');

  const lost: TaskRow = { ...ready, id: 'revoked01', project_id: 'lost' };
  const hidden: TaskRow = { ...ready, id: 'hidden001', retention_status: 'user_deleted' };
  const moved: TaskRow = { ...ready, id: 'moved0001', owner_user_id: 'other' };
  const retained: TaskRow = { ...ready, id: 'retain001', retention_status: 'retained' };
  const orphan: TaskRow = { ...ready, id: 'orphan001', project_id: null, owner_user_id: 'other' };
  const deniedProject: ProjectRow = { ...ownerProject, id: 'lost', owner_user_id: 'other' };
  const authDb = database([lost, hidden, moved, retained, orphan], [ownerProject, deniedProject]);
  const auth = await readUsageMedia(authDb.db, user,
    [fact(lost), fact(hidden), fact(moved, { ownerUserId: 'self' }), fact(retained), fact(orphan, { ownerUserId: 'self' })], self);
  assert.equal(auth.has('video_task:revoked01'), false);
  assert.equal(auth.has('video_task:hidden001'), false);
  assert.equal(auth.has('video_task:moved0001'), false);
  assert.equal(auth.has('video_task:orphan001'), false);
  assert.equal(auth.get('video_task:retain001')?.available, 1);
  const deletedDb = database([ready], [{ ...ownerProject, status: 'deleted' }]);
  assert.equal((await readUsageMedia(deletedDb.db, user, [fact(ready)], self)).size, 0);
  assert.equal((await readUsageMedia(initial.db, user, [fact(ready)], { ...self, viewerId: 'other' })).size, 0);
  checks.push('fresh_task_owner_retention_revoked_deleted_project_and_viewer_identity_fail_closed');

  const colleague: TaskRow = { ...ready, id: 'other0001', owner_user_id: 'other' };
  const membership: ProjectRow = { ...ownerProject, owner_user_id: 'other',
    members: [{ user_id: 'self', status: 'active', role: 'viewer' }] };
  const memberDb = database([colleague], [membership]);
  assert.equal((await readUsageMedia(memberDb.db, user, [fact(colleague)], team)).get('video_task:other0001')?.available, 1);
  assert.equal((await readUsageMedia(database([colleague], [{ ...membership, members: [] }]).db, user, [fact(colleague)], team)).size, 0);
  assert.equal((await readUsageMedia(memberDb.db, user, [fact(colleague)], { ...team, memberOwnerId: 'self' })).size, 0);
  const privateDb = database([orphan]);
  assert.equal((await readUsageMedia(privateDb.db, user, [fact(orphan, { projectId: 'team' })], team)).size, 0);
  const admin: SessionUser = { ...user, role: 'admin' };
  const adminDb = database([colleague, moved, hidden]);
  assert.equal((await readUsageMedia(adminDb.db, admin,
    [fact(colleague), fact(moved, { ownerUserId: 'self' }), fact(hidden)], self)).size, 0);
  checks.push('project_current_membership_not_billing_access_and_admin_self_stays_self');

  const collision: TaskRow = { ...ready, id: 'same00001' };
  const collisionImage = fact(collision, { sourceKind: 'image_task', kind: 'image' });
  const collisionDb = database([collision], [ownerProject], [{ id: collision.id, asset_id: 'asset001' }]);
  const mixed = await readUsageMedia(collisionDb.db, user, [fact(collision), collisionImage], self);
  assert.equal(mixed.size, 2);
  assert.equal(mixed.get('video_task:same00001')?.media?.videoUrl, '/api/video/play/same00001');
  assert.equal(mixed.get('video_task:same00001')?.media?.imageUrl, undefined);
  assert.ok(mixed.get('image_task:same00001')?.media?.imageUrl);
  assert.equal(mixed.get('image_task:same00001')?.media?.videoUrl, undefined);
  assert.equal(mixed.has('same00001'), false);
  const external: SessionUser = { ...user, account_type: 'external' };
  const externalMedia = await readUsageMedia(database([ready]).db, external, [fact(ready), collisionImage], self);
  assert.equal(externalMedia.get('video_task:video001')?.available, 1);
  assert.equal(externalMedia.has('image_task:same00001'), false);
  checks.push('namespaced_cross_table_ids_and_image_gate_does_not_disable_authorized_video');

  const safe = JSON.stringify(Array.from(mixed.values()));
  assert.ok(!/PRIVATE|DO_NOT_EXPORT|https?:|signature|public_video_url|local_video_path|result_video_url/.test(safe));
  for (const item of Array.from(mixed.values())) for (const value of Object.values(item.media || {})) assert.ok(value.startsWith('/api/'));
  const personalSource = readFileSync(path.join(root, 'src/lib/usage/personal.ts'), 'utf8');
  assert.ok(personalSource.includes('media.get(usageSourceKey(fact))'));
  assert.ok(personalSource.includes('readUsageMedia(db, user, allFacts, scope)'));
  assert.ok(personalSource.includes('directoryFacts') && personalSource.includes('taskCount: parent ? null : 1'));
  const viewSource = readFileSync(path.join(root, 'src/components/usage/UsageWorkspace.tsx'), 'utf8');
  assert.ok(viewSource.includes("preview?.type === 'video'") && viewSource.includes('type="video"'));
  assert.ok(viewSource.includes("preview?.type === 'image'") && viewSource.includes('type="image"'));
  assert.ok(viewSource.includes('record.media?.videoUrl') && viewSource.includes('preview.media?.videoUrl'));
  const previewSource = readFileSync(path.join(root, 'src/components/MediaPreview.tsx'), 'utf8');
  assert.ok(previewSource.includes('useMediaPreviewState') && previewSource.includes('useVideoLoopState'));
  assert.ok(previewSource.includes('media.pause()') && !/\bautoPlay\b/.test(previewSource));
  checks.push('public_media_whitelist_parent_projection_and_shared_paused_video_preview_wiring');

  const large = Array.from({ length: 501 }, (_, index) => ({ ...ready, id: `batch${String(index).padStart(5, '0')}` }));
  const largeDb = database(large);
  assert.equal((await readUsageMedia(largeDb.db, user, large.map(task => fact(task)), self)).size, 501);
  assert.equal(largeDb.calls.video, 2); assert.equal(largeDb.calls.projects.length, 1);
  assert.equal(forbiddenCalls, 0);
  checks.push('metadata_read_batches_at_most_500_reuse_snapshot_project_decision_no_business_io');

  const sources = ['src/lib/usage/media.ts', 'src/lib/usage/dto.ts', 'src/lib/usage/personal.ts',
    'src/components/usage/UsageWorkspace.tsx', 'src/components/usage/UsageWorkspace.module.css',
    'src/lib/projects/permissions.ts', 'src/lib/tasks/retention.ts', 'src/lib/video/task-thumbnail-projection.ts',
    'src/lib/video/delivery-status.ts', 'src/lib/video/thumbnail-availability.ts', 'src/lib/video/thumbnail.ts',
    'src/components/MediaPreview.tsx', 'src/lib/hooks/use-media-preview-state.ts', 'scripts/usage-video-media-engineering.ts'];
  writeFileSync(destination, JSON.stringify({ schema: 'usage-video-media-engineering.v1', synthetic: true, completed: true,
    checks, forbiddenCalls, applicationDatabaseOpened: false, paidRequests: 0, browserRuns: 0,
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])),
    scope: 'Offline transaction stub and actual permission/media projection contracts; not real database, browser or functional acceptance' }), { flag: 'wx', mode: 0o600 });
  console.log(`USAGE_VIDEO_MEDIA_ENGINEERING_RECEIPT=${destination}`);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Offline media engineering failed'); process.exitCode = 1; });
