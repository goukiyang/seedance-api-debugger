const assert = require('node:assert/strict');
const { loader } = require('./audit-task-pagination-loader.cjs');
const epoch = Date.parse('2026-10-27T12:00:00.000Z');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class MultiviewWorkError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const scalar = value => value instanceof Date ? value.getTime() : value;
function matches(row, where = {}) {
  return Object.entries(where).every(([field, value]) => {
    if (field === 'AND') return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (field === 'OR') return value.some(item => matches(row, item));
    if (field === 'NOT') return !(Array.isArray(value) ? value : [value]).some(item => matches(row, item));
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
      const actual = scalar(row[field]); expected = scalar(expected);
      if (op === 'not') return value.not && typeof value.not === 'object' ? !matches(row, { [field]: value.not }) : actual !== expected;
      if (op === 'in') return expected.includes(actual);
      if (op === 'contains') return typeof actual === 'string' && actual.includes(expected);
      if (op === 'gt') return actual !== null && actual > expected;
      if (op === 'lt') return actual !== null && actual < expected;
      throw Error('unsupported_mv_fixture_operator:' + op);
    });
    return scalar(row[field]) === scalar(value);
  });
}
function ordered(rows, orderBy = []) {
  const columns = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const column of columns) for (const [key, direction] of Object.entries(column)) {
      const left = scalar(a[key]), right = scalar(b[key]);
      if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
exports.synthetic = function (size = 1000) {
  const tasks = [], works = [], sources = [], projects = [];
  for (let i = 0; i < size; i++) {
    const id = String(i).padStart(4, '0'), project = 'project-' + id;
    projects.push({ id: project, name: 'Project ' + id, status: 'active' });
    tasks.push({ id: 'task-' + id, owner_user_id: 'owner', user_id: 'owner', project_id: project,
      source_metadata_json: i % 3 === 0 ? '{"protected_module":{}}' : null, retention_status: 'active',
      local_status: 'succeeded', created_at: new Date(epoch - Math.floor(i / 5) * 1000) });
    const sourceId = i % 3 === 2 ? 'source-' + id : null;
    if (sourceId) sources.push({ id: sourceId, owner_id: 'owner', origin_task_id: 'task-' + id });
    for (let scheme = 0; scheme < 2; scheme++) works.push({ id: 'work-' + id + '-' + scheme,
      owner_id: 'owner', source_task_id: 'task-' + id, source_id: sourceId, project_id: project,
      source_version: 'version-' + id + '-' + scheme, title: scheme ? 'Later ' + id : 'Old needle ' + id,
      status: scheme ? 'ready' : 'failed', save_state: 'committed', removed_at: null,
      created_at: new Date(epoch + (scheme + 1) * 1000 - Math.floor(i / 5) * 1000) });
  }
  return { tasks, works, sources, projects };
};
exports.harness = function (options = {}) {
  const rows = options.rows || exports.synthetic();
  const SessionAuthError = options.AuthError || AuthError;
  let user = { id: 'owner', role: 'user', account_type: 'internal', user_profile: 'artist', feature_profile_id: null, expires_at: null };
  const calls = [], permissions = [];
  const select = (row, selection) => {
    if (!row || !selection) return row;
    return Object.fromEntries(Object.entries(selection).map(([key, value]) => [key,
      key === 'project' && value ? rows.projects.find(project => project.id === row.project_id) || null : row[key]]));
  };
  const delegate = data => ({
    findMany: async args => {
      let result = ordered(data.filter(row => matches(row, args.where)), args.orderBy);
      if (args.cursor) result = result.slice(result.findIndex(row => row.id === args.cursor.id));
      return result.slice(args.skip || 0, (args.skip || 0) + args.take).map(row => select(row, args.select));
    },
    findFirst: async args => select(ordered(data.filter(row => matches(row, args.where)), args.orderBy)[0] || null, args.select),
    findUnique: async args => select(data.find(row => matches(row, args.where)) || null, args.select),
    count: async args => data.filter(row => matches(row, args.where)).length,
    groupBy: async args => {
      const groups = new Map();
      for (const row of data.filter(row => matches(row, args.where))) groups.set(JSON.stringify(args.by.map(key => row[key])),
        Object.fromEntries(args.by.map(key => [key, row[key]])));
      return ordered([...groups.values()], args.orderBy).slice(0, args.take);
    },
  });
  const wrap = (name, table) => Object.fromEntries(['findMany', 'findFirst', 'findUnique', 'count', 'groupBy'].map(method => [method, async args => {
    calls.push({ name, method, args }); return (options.prisma?.[name] || delegate(table))[method](args);
  }]));
  const prisma = { videoTask: wrap('videoTask', rows.tasks), multiviewWork: wrap('multiviewWork', rows.works), project: wrap('project', rows.projects) };
  const reference = async (actor, row) => {
    permissions.push({ ...row });
    if (row.owner_id !== actor.id) throw new AuthError('denied', 403);
    if (row.source_id) {
      const source = rows.sources.find(source => source.id === row.source_id);
      if (!source || source.owner_id !== actor.id || source.origin_task_id !== row.source_task_id) throw new AuthError('denied source', 404);
    } else {
      const task = rows.tasks.find(task => task.id === row.source_task_id);
      if (!task || task.retention_status !== 'active' || rows.projects.find(project => project.id === task.project_id)?.denied) throw new AuthError('denied task', 404);
      if (!task.project_id && (task.owner_user_id || task.user_id) !== actor.id && actor.role !== 'admin') throw new AuthError('denied owner', 403);
    }
  };
  const load = loader({
    '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError: SessionAuthError },
    './multiview-task-privacy': { privateMultiviewTaskWhere: () => ({ source_metadata_json: { contains: '"protected_module"' } }) },
    './multiview-works': { MultiviewWorkError,
      currentMultiviewActor: options.currentActor || (async actor => { assert.equal(actor.id, user.id); return user; }),
      assertMultiviewWorkReference: options.reference || reference },
    '@/lib/tasks/retention': { USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
    '@/lib/security/secrets': { requireSecret: purpose => { assert.equal(purpose, 'media'); return Buffer.alloc(32, 9); } },
    '@/lib/http/route': { route: (_policy, handler) => handler }, 'next/server': { NextResponse: { json: Response.json } },
    '@/lib/video/multiview-work-api': { multiviewWorkRoute: async (request, _mutate, action) => {
      const expected = request.headers.get('x-app-session-user');
      if (expected && expected !== user.id) return Response.json({ error: 'changed' }, { status: 409 });
      try { return Response.json(await action(user)); }
      catch (error) { if (error instanceof SessionAuthError || error instanceof MultiviewWorkError || error instanceof load('@/lib/pagination/cursor').PaginationError)
        return Response.json({ error: error.message }, { status: error.status }); throw error; }
    } },
  });
  return { load, rows, calls, permissions, prisma, get user() { return user; }, setUser(next) { user = next; },
    list: input => load('src/lib/video/multiview-records.server.ts').listMultiviewRecords(user, { q: '', projectId: '', removed: false, cursor: null, ...input }),
    request: (query, owner) => ({ nextUrl: new URL('https://synthetic.invalid/?' + query), headers: new Headers({ 'x-app-session-user': owner || user.id }) }) };
};
exports.allPages = async (h, extra = {}, field = 'items') => {
  let cursor = null, pages = 0, total; const items = [];
  do {
    const result = await h.list({ limit: '100', ...extra, cursor }); total ??= result.total;
    assert.equal(result.total, total); assert.ok(result[field].length <= 100); items.push(...result[field]); cursor = result.nextCursor;
    assert.ok(++pages <= 10000, 'nonterminating pagination');
  } while (cursor);
  assert.equal(items.length, total); assert.equal(new Set(items.map(item => item.id)).size, total);
  return { items, total, pages };
};
