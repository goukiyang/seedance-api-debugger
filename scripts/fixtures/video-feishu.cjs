'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
function load(file, imports = {}, globals = {}) {
  if (!fs.existsSync(path.join(root, file))) return {};
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { console, Buffer, Blob, FormData, Headers, Request, Response, URL,
    AbortSignal, AbortController, TextEncoder, process: { env: {}, platform: process.platform, cwd: () => '/synthetic-runtime' },
    setTimeout, clearTimeout, ...globals }, { filename: file })(name => {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name.startsWith('node:')) return require(name);
      throw Error('Unprovided fixture boundary: ' + name);
    }, module, module.exports);
  return module.exports;
}
const contract = load('src/lib/video/feishu-contract.ts');
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
const config = { appId: 'synthetic-app', appSecret: 'synthetic-not-real', tenant: 'synthetic-tenant' };
const feedback = { LEASE_MS: 90000, SEND_WINDOW_MS: 3000000, feedbackConfig: () => config,
  recipientIdentity: (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex') };
const retention = load('src/lib/tasks/retention.ts');
const noGlobalDb = new Proxy({}, { get() { throw Error('Global DB escape prohibited in supplied-db fixture'); } });
const permissions = load('src/lib/projects/permissions.ts', {
  '@/lib/prisma': { prisma: noGlobalDb }, '@/lib/auth/session': { AuthError }, '@/lib/tasks/retention': retention,
  // This flag only controls manage capabilities; actual getProjectAccess/read authorization is not mocked.
  '@/lib/access/feature-guard': { isFeatureAllowed: () => false, assertFeatureAllowed: () => { throw Error('unused manage guard'); } },
});
const privacy = load('src/lib/video/multiview-task-privacy.ts', { './task-thumbnail-projection': {
  taskThumbnailProjection() { throw Error('unused thumbnail boundary'); },
} });
const notification = load('src/lib/video/feishu-notification.ts', {
  '@/lib/auth/session': { AuthError }, '@/lib/feedback/notification': feedback, '@/lib/projects/permissions': permissions,
  './multiview-task-privacy': privacy, '@/lib/tasks/retention': retention, './feishu-contract': contract,
});
const copy = value => structuredClone(value);
function fakeDb() {
  const state = { users: new Map(), tasks: new Map(), preferences: new Map(), notifications: new Map(), project: null, writes: [], reads: [] };
  const actor = { id: 'actor', name: 'Synthetic', username: 'synthetic', email: 'synthetic@invalid.test', role: 'user', account_type: 'internal',
    user_profile: 'other', feature_profile_id: null, status: 'active', expires_at: null, feishu_open_id: 'ou_synthetic', feishu_tenant_key: config.tenant };
  state.users.set(actor.id, actor);
  const task = { id: 'synthetic-task', user_id: 'actor', owner_user_id: 'actor', project_id: null, retention_status: 'active', source_metadata_json: null,
    local_status: 'succeeded', local_video_path: '/videos/synthetic-task.mp4', public_video_url: null, public_video_storage_provider: null,
    public_video_storage_key: null, public_video_file_size: null, public_video_cached_at: null };
  state.tasks.set(task.id, task);
  const match = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const db = {
    user: { findUnique: async ({ where }) => { state.reads.push('user'); return copy(state.users.get(where.id) || null); } },
    videoTask: { findUnique: async ({ where }) => { state.reads.push('videoTask'); return copy(state.tasks.get(where.id) || null); } },
    project: { findUnique: async () => { state.reads.push('project'); return copy(state.project); } },
    userPreference: {
      findUnique: async ({ where }) => { state.reads.push('preference'); return copy(state.preferences.get(where.user_id_key.user_id) || null); },
      create: async ({ data }) => {
        if (state.preferences.has(data.user_id)) throw Object.assign(Error('synthetic conflict'), { code: 'P2002' });
        state.preferences.set(data.user_id, { id: 'preference', ...copy(data) }); state.writes.push('preference.create');
      },
      updateMany: async ({ where, data }) => {
        const row = state.preferences.get(where.user_id); if (!row || !match(row, where)) return { count: 0 };
        Object.assign(row, copy(data)); state.writes.push('preference.update'); return { count: 1 };
      },
    },
    notification: {
      findUnique: async ({ where }) => copy(state.notifications.get(where.id) || null),
      create: async ({ data }) => {
        if (state.notifications.has(data.id)) throw Object.assign(Error('synthetic conflict'), { code: 'P2002' });
        state.notifications.set(data.id, copy(data)); state.writes.push('notification.create');
      },
      updateMany: async ({ where, data }) => {
        const row = state.notifications.get(where.id); if (!row || !match(row, where)) return { count: 0 };
        Object.assign(row, copy(data)); state.writes.push('notification.update'); return { count: 1 };
      },
    },
  };
  return { db, state, actor, task };
}
async function eventFixture() {
  const fixture = fakeDb();
  const preference = await notification.saveVideoFeishuPreference(fixture.db, 'actor', { version: 1, enabled: true, revision: 0 });
  await notification.enqueueVideoFeishuNotification(fixture.db, 'actor', fixture.task,
    { version: 1, enabled: true, preferenceRevision: preference.revision });
  const id = contract.videoFeishuUuid(fixture.task.id, 'event');
  fixture.row = () => copy(fixture.state.notifications.get(id));
  fixture.meta = () => JSON.parse(fixture.row().metadata_json);
  fixture.changeMeta = change => { const row = fixture.state.notifications.get(id), meta = JSON.parse(row.metadata_json); change(meta); row.metadata_json = JSON.stringify(meta); };
  fixture.ready = () => fixture.changeMeta(meta => { meta.nextAttemptAt = 0; });
  return fixture;
}
function delivery(fixture, options = {}) {
  const calls = [], source = { version: 'a'.repeat(64), hash: 'b'.repeat(64), mode: 'video', reason: null,
    video: new Blob(['synthetic-not-real-video'], { type: 'video/mp4' }), cover: new Blob(['synthetic-not-real-cover'], { type: 'image/jpeg' }), durationMs: 1000,
    current: async () => options.current ? options.current() : true, close: async () => { calls.push('close'); }, ...options.source };
  const consumer = load('src/lib/video/feishu-delivery.ts', {
    '@/lib/prisma': { prisma: options.prisma || noGlobalDb }, '@/lib/feedback/delivery': { feedbackTenantToken: async () => 'synthetic-token' },
    '@/lib/feedback/notification': feedback, './feishu-contract': contract, './feishu-notification': notification,
    './feishu-source': { prepareVideoFeishuSource: async () => { calls.push('prepare'); if (options.prepare) await options.prepare(); return source; },
      videoFeishuSourceStamp: task => JSON.stringify(task) },
    './feishu-transport': {
      uploadVideoFeishuFile: async () => { calls.push('upload'); if (options.upload) return options.upload(fixture); return 'file_synthetic'; },
      uploadVideoFeishuCover: async () => { calls.push('cover'); return 'img_synthetic'; },
      sendVideoFeishuMessage: async (...args) => { calls.push(args[3]); return options.send ? options.send(args, fixture) : `om_${args[3]}`; },
    },
  });
  return { ...consumer, calls, run: () => consumer.deliverVideoFeishuNotification(fixture.db, fixture.row()) };
}
module.exports = { load, root, contract, AuthError, config, feedback, notification, fakeDb, eventFixture, delivery };
