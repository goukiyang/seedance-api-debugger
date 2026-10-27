const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('src/lib/feedback/notification.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const deps = {
  'node:crypto': require('node:crypto'),
  '@prisma/client': { PrismaClient: class {} },
  '@/lib/prisma': { prisma: {} },
  '@/lib/navigation': { adminNavItems: [], userNavItems: [], isNavItemActive: () => false },
  './attachments': { validFeedbackAttachments: () => true },
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  assert.ok(Object.hasOwn(deps, name), `Unreviewed dependency ${name}`); return deps[name];
}, mod, mod.exports);
const { anonymousFeedbackBucket, anonymousFeedbackMessage, enqueueFeedbackNotification, recipientIdentity, parseFeedbackDelivery } = mod.exports;
Object.assign(process.env, { FEISHU_FEEDBACK_ENABLED: 'true', FEISHU_FEEDBACK_RECIPIENT_USER_ID: 'admin',
  FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-not-used', FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant' });
process.env.FEISHU_FEEDBACK_IDENTITY_SHA256 = recipientIdentity('admin', 'synthetic-open', 'synthetic-app', 'synthetic-tenant');
const recipient = { id: 'admin', role: 'admin', status: 'active', expires_at: null, feishu_open_id: 'synthetic-open', feishu_tenant_key: 'synthetic-tenant' };
const rows = new Map();
let immediate = 0;
const tx = { user: { findUnique: async () => recipient }, notification: {
  upsert: async ({ where, update, create }) => {
    assert.deepEqual(update, {}, 'later submissions must not reset sent/unknown jobs');
    if (!rows.has(where.id)) rows.set(where.id, create);
    return rows.get(where.id);
  },
  create: async () => { immediate++; },
} };
async function main() {
  const first = new Date('2026-10-27T12:10:00Z'), next = new Date('2026-10-27T12:59:59Z');
  assert.equal(anonymousFeedbackBucket(first).feedbackId, anonymousFeedbackBucket(next).feedbackId);
  assert.notEqual(anonymousFeedbackBucket(next).feedbackId, anonymousFeedbackBucket(new Date('2026-10-27T13:00:00Z')).feedbackId);
  const feedback = { id: 'one', content: 'token=NEVER_NOTIFY_THIS', pathname: '/login', created_at: first };
  await enqueueFeedbackNotification(tx, feedback, null, 0);
  await enqueueFeedbackNotification(tx, { ...feedback, id: 'two', created_at: next }, null, 0);
  assert.equal(immediate, 0);
  assert.equal(rows.size, 1);
  const row = [...rows.values()][0], meta = parseFeedbackDelivery(row.metadata_json);
  assert.ok(meta);
  assert.equal(meta.nextAttemptAt, Date.parse('2026-10-27T13:00:00Z'));
  assert.equal(meta.anonymousDigest.start, Date.parse('2026-10-27T12:00:00Z'));
  assert.equal(JSON.stringify(row).includes('NEVER_NOTIFY_THIS'), false);
  assert.equal(meta.message, undefined, 'count must be fixed only after the hour closes');
  row.status = 'sent'; row.metadata_json = JSON.stringify({ ...meta, state: 'sent', receiptId: 'original' });
  await enqueueFeedbackNotification(tx, { ...feedback, id: 'three', created_at: next }, null, 0);
  assert.equal(row.status, 'sent');
  assert.equal(parseFeedbackDelivery(row.metadata_json).receiptId, 'original');
  await enqueueFeedbackNotification(tx, { ...feedback, id: 'four', created_at: new Date('2026-10-27T13:00:00Z') }, null, 0);
  assert.equal(rows.size, 2);
  await enqueueFeedbackNotification(tx, feedback, { id: 'signed-user', name: 'User' }, 0);
  assert.equal(immediate, 1, 'signed-in feedback preserves the existing immediate notification path');
  assert.equal(parseFeedbackDelivery(JSON.stringify({ ...meta, anonymousDigest: { start: first.getTime(), end: first.getTime() + 7_200_000 } })), null);
  assert.match(JSON.parse(anonymousFeedbackMessage(3).content).text, /3 条/);
  assert.throws(() => anonymousFeedbackMessage(-1));
  console.log('PASS anonymous hourly notification grouping, frozen receipts, no private excerpts and signed-in continuity');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
