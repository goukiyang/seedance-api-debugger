import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { defaultPersonalProjectName, projectDisplayName } from '../src/lib/projects/display';

// Execute the actual production bodies with isolated I/O boundaries. No browser,
// production database, OAuth request, file upload or generation is used.
function productionFunction(file: string, name: string, environment: Record<string, unknown> = {}) {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `${file}:${name}`);
  const code = ts.transpileModule(`${node.getText(parsed)}\nmodule.exports = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { console, URL, Response, Request, ...environment, module, exports: module.exports }, { filename: file });
  return module.exports as (...args: any[]) => any;
}

const FEISHU = 'https://example.test/feishu-photo.png';
const passed: string[] = [];
async function check(label: string, run: () => unknown) { await run(); passed.push(label); }

async function main() {
  for (const name of ['小波', '另一位同事']) await check(`default owner ${name}`, () => {
    assert.equal(projectDisplayName({ name: '我的默认项目', type: 'personal', owner: { name } }), `${name}的默认项目`);
  });
  await check('new default uses account display name', () => assert.equal(defaultPersonalProjectName({ name: '小波', username: 'ou_technical' }), '小波的默认项目'));
  await check('custom personal name retained', () => assert.equal(projectDisplayName({ name: '我的试稿', type: 'personal', owner: { name: '小波' } }), '我的试稿'));
  await check('team name retained', () => assert.equal(projectDisplayName({ name: '我的默认项目', type: 'team', owner: { name: '小波' } }), '我的默认项目'));
  await check('unknown owner is not replaced by viewer', () => assert.equal(projectDisplayName({ name: '我的默认项目', type: 'personal' }), '个人默认项目'));

  const snapshot = { owner: { userId: 'u1', username: 'u1', displayName: '原姓名', avatarUrl: '/old-custom', accountType: 'internal' },
    input: { name: '草稿', groupName: '', values: {}, draftPrompt: '原描述' }, templateVersion: null, recipe: null,
    prompt: '原执行提示词', parameters: {}, assets: [] };
  const unchanged = JSON.stringify(snapshot);
  const live = { id: 'u1', avatar_url: FEISHU, feishu: { user_id: null, open_id: 'ou_synthetic' } };
  const publicSnapshot = productionFunction('src/lib/template-studio/projection.ts', 'publicRunSnapshot', { publicRecipe: () => null });
  await check('historical display uses current Feishu photo', () => {
    assert.equal(publicSnapshot(snapshot, live).owner.avatarUrl, FEISHU);
    assert.equal(JSON.stringify(snapshot), unchanged);
  });
  await check('handoff without live display context stays frozen', () => assert.equal(publicSnapshot(snapshot).owner.avatarUrl, '/old-custom'));
  await check('another identity cannot supply the photo', () => assert.equal(publicSnapshot(snapshot, { ...live, id: 'u2' }).owner.avatarUrl, '/old-custom'));
  await check('non Feishu history stays unchanged', () => assert.equal(publicSnapshot(snapshot, { id: 'u1', avatar_url: '/new-custom' }).owner.avatarUrl, '/old-custom'));

  // The unchanged raw-profile redactor is outside this avatar-policy unit.
  const safeProfileJson = () => '{"synthetic":true}';
  const sync = productionFunction('src/lib/auth/feishu.ts', 'syncExistingUser', { safeProfileJson, FeishuAuthError: Error });
  for (const previous of ['custom', 'initials', 'feishu']) await check(`sync supersedes ${previous} preference`, async () => {
    let data: any;
    const tx = { user: { update: async (input: any) => { data = input.data; return { id: 'u1', ...input.data }; } },
      operationLog: { create: async () => ({}) } };
    await sync(tx, { id: 'u1', status: 'active', expires_at: null, email: 'same@example.test', avatar_source: previous,
      avatar_url: '/old-custom', feishu_avatar_url: FEISHU },
    { name: '小波', mobile: null, avatarUrl: 'https://example.test/new-feishu.png', email: 'same@example.test', userId: 'fu1', openId: 'ou1', unionId: null,
      tenantKey: 'synthetic', employeeNo: null, departmentIds: [], raw: {} });
    assert.equal(data.avatar_url, 'https://example.test/new-feishu.png');
    assert.equal(data.feishu_avatar_url, data.avatar_url);
    assert.equal(data.avatar_source, 'feishu');
    assert.equal(data.feishu_open_id, 'ou1');
  });
  await check('brief profile without image preserves known Feishu photo', async () => {
    let data: any;
    await sync({ user: { update: async (input: any) => { data = input.data; return input.data; } }, operationLog: { create: async () => ({}) } },
      { id: 'u1', status: 'active', expires_at: null, email: '', avatar_source: 'feishu', avatar_url: FEISHU, feishu_avatar_url: FEISHU },
      { name: '小波', email: null, avatarUrl: null, departmentIds: [], raw: {} });
    assert.equal(data.avatar_url, FEISHU);
    assert.equal(data.feishu_avatar_url, FEISHU);
  });

  let actor: any = { id: 'u1', status: 'active', feishu: { open_id: 'ou1' } };
  const writes: string[] = [];
  const post = productionFunction('src/app/api/me/avatar/route.ts', 'POST', {
    headers: { 'Cache-Control': 'private, no-store' }, getSession: async () => actor,
    NextResponse: { json: (value: unknown, options: any = {}) => new Response(JSON.stringify(value), options) }, AvatarError: Error,
    setCustomAvatar: async () => { writes.push('custom'); return { avatarUrl: '/custom' }; },
    restoreAvatar: async (_actor: unknown, _id: unknown, action: string) => { writes.push(action); return { avatarUrl: FEISHU }; },
  });
  const request = (action: string) => new Request('https://sd2.youdooart.com/api/me/avatar', {
    method: 'POST', headers: { Origin: 'https://sd2.youdooart.com', Host: 'sd2.youdooart.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  });
  for (const action of ['custom', 'initials']) await check(`Feishu ${action} denied before writes`, async () => {
    writes.length = 0; assert.equal((await post(request(action))).status, 403); assert.equal(writes.length, 0);
  });
  await check('user_id-only Feishu binding is also protected', async () => {
    actor = { id: 'u1', status: 'active', feishu: { user_id: 'fu1' } };
    writes.length = 0; assert.equal((await post(request('custom'))).status, 403); assert.equal(writes.length, 0);
  });
  await check('Feishu restore remains usable', async () => assert.equal((await post(request('feishu'))).status, 200));
  for (const action of ['custom', 'initials']) await check(`non Feishu ${action} retained`, async () => {
    actor = { id: 'u2', status: 'active' }; writes.length = 0;
    assert.equal((await post(request(action))).status, 200); assert.equal(writes[0], action);
  });
  await check('signed out caller cannot write', async () => {
    actor = null; writes.length = 0; assert.equal((await post(request('custom'))).status, 401); assert.equal(writes.length, 0);
  });

  await check('usage photos are one bounded batch and leave money unchanged', async () => {
    let reads = 0, disposed = 0;
    const currentUsageAvatars = productionFunction('src/lib/admin/usage-analytics.ts', 'currentUsageAvatars', {
      prisma: { user: { findMany: async (input: any) => { reads++; assert.equal(JSON.stringify(input.select), '{"id":true,"avatar_url":true}');
        assert.equal(JSON.stringify(input.where.id.in.sort()), '["u1","u2"]'); return [{ id: 'u1', avatar_url: FEISHU }, { id: 'u2', avatar_url: '/custom' }]; } } },
    });
    const report = { summary: { confirmedCostCnyMicros: '123456' }, members: { rows: [{ id: 'u1', label: '甲' }] },
      memberDirectory: { rows: [{ id: 'u1', label: '甲' }, { id: 'u2', label: '乙' }] }, selectedMember: { id: 'u1', label: '甲', available: true },
      records: { rows: [{ ownerUserId: 'u1', chargedPoints: '12.5', accountingCost: { amountCnyMicros: '123456' } }] } };
    const original = JSON.stringify(report);
    const get = productionFunction('src/lib/admin/usage-analytics.ts', 'getUsageAnalytics', {
      currentUsageAvatars, getUsageAnalyticsSnapshot: async () => ({ report, dispose: async () => { disposed++; } }),
    });
    const result = await get({});
    assert.equal(result.members.rows[0].avatarUrl, FEISHU); assert.equal(result.records.rows[0].ownerAvatarUrl, FEISHU);
    assert.equal(result.selectedMember.avatarUrl, FEISHU); assert.equal(result.memberDirectory.rows[1].avatarUrl, '/custom');
    assert.equal(result.summary, report.summary); assert.equal(result.records.rows[0].chargedPoints, '12.5');
    assert.equal(JSON.stringify(report), original); assert.equal(reads, 1); assert.equal(disposed, 1);
  });
  await check('optional photo failure preserves captured report', async () => {
    const currentUsageAvatars = productionFunction('src/lib/admin/usage-analytics.ts', 'currentUsageAvatars', {
      console: { warn: () => {} }, prisma: { user: { findMany: async () => { throw new Error('synthetic read error'); } } },
    });
    const result = await currentUsageAvatars(['u1']); assert.equal(result.size, 0);
  });
  console.log(JSON.stringify({ passed: passed.length, cases: passed, productionWrites: 0, browserRuns: 0, paidRequests: 0 }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
