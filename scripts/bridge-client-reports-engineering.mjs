import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
const { build } = require('esbuild');
const { NextRequest } = require('next/server');

const state = {
  created: [],
  existing: null,
  findManyArgs: null,
};
globalThis.__bridgeReportEngineeringState = state;
globalThis.__bridgeReportEngineeringUser = null;

async function loadEntry(entry, name, includeSession = false) {
  const plugins = [{
    name: 'bridge-engineering-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\/lib\/prisma$/ }, () => ({ path: 'prisma', namespace: 'bridge-stub' }));
      buildApi.onLoad({ filter: /^prisma$/, namespace: 'bridge-stub' }, () => ({
        loader: 'js',
        contents: `
          const state = globalThis.__bridgeReportEngineeringState;
          export const prisma = { operationLog: {
            findFirst: async () => state.existing,
            create: async args => { state.created.push(args); return { id: 'synthetic-' + state.created.length }; },
            findMany: async args => { state.findManyArgs = args; return []; }
          } };
        `,
      }));
      if (includeSession) {
        buildApi.onResolve({ filter: /^@\/lib\/auth\/session$/ }, () => ({ path: 'session', namespace: 'bridge-stub' }));
        buildApi.onLoad({ filter: /^session$/, namespace: 'bridge-stub' }, () => ({
          loader: 'js',
          contents: 'export const getSession = async () => globalThis.__bridgeReportEngineeringUser;',
        }));
      }
    },
  }];
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['next/server'],
    plugins,
  });
  const filename = `/tmp/${name}.cjs`;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(process.cwd());
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports;
}

function resetSink() {
  state.created.length = 0;
  state.existing = null;
  state.findManyArgs = null;
}

const reports = await loadEntry('src/lib/bridge/client-reports.ts', 'bridge-client-reports-engineering-service');
const fixture = {
  fingerprint: 'gpt-queue:send.fail:0.2.20',
  kind: 'gpt-queue:send.fail',
  version: '0.2.20',
  rulesVersion: 'synthetic-rules',
  site: 'chatgpt.com',
  message: 'TypeError: SYNTHETIC_CHAT_TEXT access_token=SYNTHETIC_MESSAGE_SECRET',
  items: [
    { t: '2026-11-01T01:02:03.000Z', lv: 'info', at: 'chatgpt.com', m: 'meta', e: 'versions', d: { ext: '0.2.20', rules: 'synthetic-rules' } },
    {
      t: '2026-11-01T01:02:04.000Z', lv: 'error', at: 'chatgpt.com', m: 'gpt-queue', e: 'send.fail',
      d: {
        idx: 2,
        running: true,
        error: 'SYNTHETIC_ITEM_CHAT_TEXT token=SYNTHETIC_ITEM_SECRET',
        requestUrl: 'https://example.invalid/api/run?access_token=SYNTHETIC_QUERY_SECRET#private',
        token: 'SYNTHETIC_KEY_SECRET',
        image: 'data:image/png;base64,SYNTHETIC_DIRECT_IMAGE',
      },
    },
  ],
  dom: {
    tag: 'main', testid: 'conversation-turn', role: 'main', cls: 'relative flex',
    href: '/c/synthetic-id?token=SYNTHETIC_DOM_QUERY#private',
    text: 'SYNTHETIC_DOM_CHAT_TEXT',
    html: '<img src="data:image/png;base64,SYNTHETIC_EMBEDDED_IMAGE">',
    value: 'SYNTHETIC_DOM_VALUE',
    prompt: 'SYNTHETIC_DOM_PROMPT',
    c: [{ tag: 'img', src: 'images.example.invalid', alt: 'SYNTHETIC_ALT_TEXT', payload: 'data:image/png;base64,SYNTHETIC_CHILD_IMAGE' }],
  },
  ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 SYNTHETIC_UA_TEXT',
};

const normalized = reports.normalizeReport(fixture);
assert(normalized, 'real producer fixture should normalize');
assert.equal(normalized.fingerprint, fixture.fingerprint);
assert.equal(normalized.kind, fixture.kind);
assert.equal(normalized.version, fixture.version);
await reports.saveClientReport('synthetic-user', normalized);
assert.equal(state.created.length, 1);
const persisted = state.created[0].data;
const detail = JSON.parse(persisted.detail);
const forbidden = [
  'SYNTHETIC_CHAT_TEXT', 'SYNTHETIC_MESSAGE_SECRET', 'SYNTHETIC_ITEM_CHAT_TEXT',
  'SYNTHETIC_ITEM_SECRET', 'SYNTHETIC_QUERY_SECRET', 'SYNTHETIC_KEY_SECRET',
  'SYNTHETIC_DIRECT_IMAGE', 'SYNTHETIC_DOM_QUERY', 'SYNTHETIC_DOM_CHAT_TEXT',
  'SYNTHETIC_EMBEDDED_IMAGE', 'SYNTHETIC_DOM_VALUE', 'SYNTHETIC_DOM_PROMPT',
  'SYNTHETIC_ALT_TEXT', 'SYNTHETIC_CHILD_IMAGE', 'SYNTHETIC_UA_TEXT',
];
for (const marker of forbidden) assert(!persisted.detail.includes(marker), `persisted detail leaked ${marker}`);
assert.equal(detail.message.redacted, true);
assert.equal(detail.message.error_type, 'TypeError');
assert.equal(detail.items[1].m, 'gpt-queue');
assert.equal(detail.items[1].e, 'send.fail');
assert.equal(detail.items[1].d.idx, 2);
assert.equal(detail.items[1].d.running, true);
assert.equal(detail.items[1].d.requestUrl, 'https://example.invalid/api/run');
assert.deepEqual(detail.items[1].d.image, { redacted: true, kind: 'data', length: fixture.items[1].d.image.length });
assert.equal(detail.dom.tag, 'main');
assert.equal(detail.dom.href, '/c/synthetic-id');
assert.deepEqual(Object.keys(detail.dom).sort(), ['c', 'cls', 'href', 'role', 'tag', 'testid']);
assert.deepEqual(detail.dom.c[0], { tag: 'img', src: 'images.example.invalid' });
assert.equal(detail.ua.family, 'Chrome');
assert.equal(detail.ua.platform, 'macOS');
assert(Buffer.byteLength(persisted.detail, 'utf8') <= 48 * 1024);

resetSink();
const invalidVersion = reports.normalizeReport({
  ...fixture,
  fingerprint: 'gpt-queue:send.fail:SYNTHETIC_TOKEN_SECRET',
  version: 'SYNTHETIC_TOKEN_SECRET',
  message: 'TypeError: version fallback fixture',
});
assert(invalidVersion);
assert.match(invalidVersion.fingerprint, /^invalid:[a-f0-9]{32}$/);
assert.equal(invalidVersion.version, '');
await reports.saveClientReport('synthetic-user', invalidVersion);
const invalidVersionDetail = state.created[0].data.detail;
assert(!invalidVersionDetail.includes('SYNTHETIC_TOKEN_SECRET'));

resetSink();
const customErrorType = reports.normalizeReport({
  ...fixture,
  fingerprint: 'gpt-queue:custom-error.fail:0.2.14',
  version: '0.2.14',
  message: 'SYNTHETIC_SECRETError: custom type must not be retained',
});
assert(customErrorType);
await reports.saveClientReport('synthetic-user', customErrorType);
const customErrorDetail = JSON.parse(state.created[0].data.detail);
assert.equal(customErrorDetail.version, '0.2.14');
assert.equal(customErrorDetail.message.error_type, undefined);
assert(!state.created[0].data.detail.includes('SYNTHETIC_SECRETError'));

await reports.listClientReports({ kind: 'gpt-queue:send.' });
assert.equal(state.findManyArgs.where.target_id.startsWith, 'gpt-queue:send.');
const kindFilter = state.findManyArgs.where.target_id.startsWith;

resetSink();
const largeItems = Array.from({ length: 41 }, (_, index) => ({
  t: `2026-11-01T01:02:${String(index % 60).padStart(2, '0')}.000Z`,
  lv: 'error', at: 'chatgpt.com', m: 'gpt-queue', e: 'send.fail',
  d: Object.fromEntries(Array.from({ length: 30 }, (_unused, key) => [`field${key}`, `隐私内容-${index}-${key}-` + '界'.repeat(480)])),
}));
const large = reports.normalizeReport({ ...fixture, fingerprint: 'gpt-queue:size.fail:0.2.20', kind: 'gpt-queue:size.fail', items: largeItems });
assert(large);
await reports.saveClientReport('synthetic-user', large);
const largeDetailText = state.created[0].data.detail;
const largeDetail = JSON.parse(largeDetailText);
assert(Buffer.byteLength(largeDetailText, 'utf8') <= 48 * 1024);
assert(Array.isArray(largeDetail.items));

for (let index = 0; index < 30; index += 1) assert.equal(reports.rateLimited('rate-user', 1000 + index), false);
assert.equal(reports.rateLimited('rate-user', 1030), true);

resetSink();
const route = await loadEntry('src/app/api/bridge/client-reports/route.ts', 'bridge-client-reports-engineering-route', true);
globalThis.__bridgeReportEngineeringUser = null;
const anonymousPost = await route.POST(new NextRequest('http://localhost/api/bridge/client-reports', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture),
}));
assert.equal(anonymousPost.status, 401);

globalThis.__bridgeReportEngineeringUser = { id: 'normal-user', role: 'user' };
const normalGet = await route.GET(new NextRequest('http://localhost/api/bridge/client-reports'));
assert.equal(normalGet.status, 403);

globalThis.__bridgeReportEngineeringUser = { id: 'admin-user', role: 'admin' };
const adminGet = await route.GET(new NextRequest('http://localhost/api/bridge/client-reports'));
assert.equal(adminGet.status, 200);
assert.deepEqual(await adminGet.json(), { ok: true, reports: [] });

console.log(JSON.stringify({
  producer_fixture: 'passed',
  manifest_versions: '0.2.14 and 0.2.20 accepted; non-numeric version redacted',
  trusted_error_types: 'TypeError retained; custom *Error redacted',
  privacy_markers_removed: forbidden.length,
  stored_technical_identity: { fingerprint: detail.fingerprint, kind: detail.kind, module: detail.items[1].m, event: detail.items[1].e },
  detail_utf8_bytes: Buffer.byteLength(persisted.detail, 'utf8'),
  large_detail_utf8_bytes: Buffer.byteLength(largeDetailText, 'utf8'),
  large_detail_items: largeDetail.items.length,
  kind_filter: kindFilter,
  rate_limit: '30 accepted, 31st rejected',
  route_identity: { anonymous_post: anonymousPost.status, normal_get: normalGet.status, admin_get: adminGet.status },
}, null, 2));
