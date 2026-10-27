const assert = require('node:assert/strict');
const { loader } = require('./audit-task-pagination-loader.cjs');
const base = Date.parse('2026-10-27T12:00:00.000Z');
const secret = Buffer.alloc(32, 7);
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
exports.taskRoutes = ['src/app/api/video/list/route.ts', 'src/app/api/ip/video/list/route.ts', 'src/app/api/video-cards/[id]/tasks/route.ts'];
exports.syntheticTasks = () => ['normal', 'ip'].flatMap(kind => Array.from({ length: 1000 }, (_, i) => ({
  id: `${kind}-${String(i).padStart(4, '0')}`, provider: kind === 'ip' ? 'volcengine_ip' : 'seedance',
  owner_user_id: 'owner', user_id: 'owner', project_id: 'p1', video_card_id: kind === 'ip' ? 'ip-card' : 'card',
  retention_status: 'active', local_status: 'succeeded', created_at: new Date(base - Math.floor(i / 5) * 1000),
})));
exports.syntheticAssets = () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `asset-${String(i).padStart(4, '0')}`, owner_id: 'owner', ownership_status: 'owned',
    provider: 'seedance', provider_asset_id: 'provider-' + i, asset_type: 'Image', name: 'synthetic', original_url: '/synthetic/never-fetched.png',
    provider_preview_url: null, provider_status: 'Active', local_status: 'Active', raw_provider_response: null, last_synced_at: null, deleted_at: null,
    provider_deleted_at: null, delete_error: null, group_id: null, project_name: null, file_hash: null, storage_provider: null, storage_key: null,
    created_at: new Date(base - Math.floor(i / 5) * 1000), updated_at: new Date(base) }));
  rows.push({ ...rows[0], id: 'foreign', provider_asset_id: 'foreign', owner_id: 'other' },
    { ...rows[0], id: 'quarantine', provider_asset_id: 'quarantine', owner_id: null, ownership_status: 'quarantined' },
    { ...rows[0], id: 'deleted', provider_asset_id: 'deleted', local_status: 'Deleted' });
  return rows;
};
const scalar = value => value instanceof Date ? value.getTime() : value;
function matches(row, where = {}) {
  return Object.entries(where).every(([field, value]) => {
    if (field === 'AND') return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (field === 'OR') return value.some(item => matches(row, item));
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([operator, expected]) => {
      const actual = scalar(row[field]); expected = scalar(expected);
      if (operator === 'not') return actual !== expected;
      if (operator === 'in') return expected.includes(actual);
      if (operator === 'notIn') return !expected.includes(actual);
      if (operator === 'lt') return actual < expected;
      if (operator === 'gt') return actual > expected;
      throw new Error('unsupported_fixture_operator:' + operator);
    });
    return scalar(row[field]) === scalar(value);
  });
}
exports.ordered = rows => [...rows].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
function memoryDelegate(rows) {
  return { count: async ({ where }) => rows.filter(row => matches(row, where)).length,
    findFirst: async ({ where }) => rows.find(row => matches(row, where)) || null,
    findMany: async args => exports.ordered(rows.filter(row => matches(row, args.where))).slice(args.skip || 0, (args.skip || 0) + args.take) };
}
exports.harness = function (options = {}) {
  let user = { id: 'owner', role: 'user', account_type: 'internal' }, permitted = true;
  const tasks = options.tasks || exports.syntheticTasks(), rows = options.rows || exports.syntheticAssets();
  const calls = [], permissions = [];
  const wrap = (model, delegate) => Object.fromEntries(['findMany', 'findFirst', 'count'].map(method => [method, async args => {
    calls.push({ model, method, args }); return delegate[method](args);
  }]));
  const prisma = { videoTask: wrap('videoTask', options.prisma?.videoTask || memoryDelegate(tasks)),
    seedanceAsset: wrap('seedanceAsset', options.prisma?.seedanceAsset || memoryDelegate(rows)) };
  const load = loader({
    '@/lib/http/route': { route: (_options, handler) => handler }, '@/lib/http/api-error': { apiErrorResponse: error => { throw error; } },
    'next/server': { NextResponse: { json: Response.json } }, '@/lib/auth/session': { getSession: async () => user, AuthError },
    '@/lib/access/feature-guard': { assertInternalOnly: viewer => { if (viewer.account_type !== 'internal') throw new AuthError('forbidden', 403); } },
    '@/lib/prisma': { prisma },
    '@/lib/dto/video-task': { toVideoTaskView: row => ({ id: row.id }), videoTaskViewSelect: { id: true, created_at: true } },
    '@/lib/projects/permissions': { getTaskWhereForUser: async (viewer, projectId, flags) => ({
      ...(flags.includeAdminAll ? {} : { owner_user_id: viewer.id }), ...(projectId ? { project_id: projectId } : {}),
      ...(flags.includeDeleted ? {} : { retention_status: { in: ['active'] } }),
    }) },
    '@/lib/video-cards/permissions': { assertCanViewVideoCard: async (viewer, id) => { permissions.push([viewer.id, id]); if (!permitted) throw new AuthError('forbidden', 403); }, assertCanManageVideoCard: async () => {} },
    '@/lib/video-cards/workflow': {}, '@/lib/tasks/retention': { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
    '@/lib/provider/volcengine-ip': { VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ip', safeVolcengineIpUserMessage: () => '' },
    '@/lib/video/task-thumbnail-projection': { taskThumbnailProjection: () => ({}) },
    '@/lib/media/seedance-projection': { seedanceMediaDTO: async (_viewer, record) => ({ ...record,
      originalUrl: record.ownershipStatus === 'owned' && record.ownerId ? '/authorized/' + record.localId : '', rawProviderResponse: undefined }) },
    '@/lib/security/secrets': { requireSecret: purpose => { assert.equal(purpose, 'media'); return secret; } },
  });
  return { load, rows, tasks, calls, permissions, prisma, setUser: value => { user = value; }, denyCard: () => { permitted = false; },
    request: (query, owner = user.id) => ({ nextUrl: new URL('https://synthetic.invalid/?' + query), headers: new Headers(owner ? { 'x-upload-owner-id': owner } : {}) }) };
};
exports.allPages = async (h, file, field = 'tasks', query = 'limit=100') => {
  const handler = h.load(file).GET, ids = []; let next = null, total = null, pages = 0;
  do {
    const params = new URLSearchParams(query); if (next) params.set('cursor', next);
    const response = await handler(h.request(params.toString()), { params: Promise.resolve({ id: 'card' }) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.ok(body[field].length <= 100); assert.ok(body[field].length <= body.pagination.limit);
    total ??= body.pagination.total; assert.equal(body.pagination.total, total);
    ids.push(...body[field].map(row => row.id || row.localId)); next = body.pagination.nextCursor;
    assert.equal(Boolean(next), body.pagination.hasMore); assert.ok(++pages <= 1000, 'cursor did not terminate');
  } while (next);
  assert.equal(ids.length, total); assert.equal(new Set(ids).size, ids.length);
  for (const call of h.calls.filter(call => call.method === 'findMany')) {
    assert.ok(Number.isInteger(call.args.take) && call.args.take <= 101);
    assert.deepEqual(call.args.orderBy, [{ created_at: 'desc' }, { id: 'desc' }]);
  }
  return { ids, total, pages };
};
