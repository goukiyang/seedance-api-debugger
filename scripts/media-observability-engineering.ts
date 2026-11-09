import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Offline real-route checks; every external I/O dependency is denied or supplied.
const root = resolve(process.argv[2] || process.cwd());
const requireLocal = createRequire(resolve(root, 'package.json'));
const checks: string[] = [];
let clock = 1000;
function load(file: string, dependencies: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(resolve(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(output, { exports, Response, Request, Headers, URL, console,
    performance: { now: () => clock }, require: (name: string) => {
      if (name in dependencies) return dependencies[name];
      if (name.startsWith('node:') || name === 'next/server') return requireLocal(name);
      throw new Error(`Unexpected dependency: ${name}`);
    } });
  return exports;
}

async function main() {
  let hdReads = 0;
  let state = 'hard_pause', reason = 'worker_integrity_failure', unavailable = false;
  const hd = load('src/lib/notifications/hd-alert.ts', {
    'server-only': {}, '@/lib/media/hd-derivatives': { hdControl: async () => {
      hdReads++;
      if (unavailable) throw new Error('/private/path must never enter the alert');
      return { state, reason, diagnostic: { message: '/private/path' } };
    } },
  });
  assert.equal((await hd.readHdSystemAlerts('user')).length, 0);
  assert.equal(hdReads, 0);
  checks.push('non_admin_never_reads_control');
  const alert = await hd.readHdSystemAlerts('admin');
  assert.equal(alert.length, 1);
  assert.equal(alert[0].id, 'hd_hard_pause');
  assert.equal(alert[0].href, '/admin/image-studio#hd-management-title');
  assert.ok(!JSON.stringify(alert).includes('/private/path'));
  checks.push('hard_pause_visible_without_paths_or_control_tokens');
  for (const next of ['active', 'manual_pause', 'resource_wait']) {
    state = next;
    assert.equal((await hd.readHdSystemAlerts('admin')).length, 0);
  }
  state = 'hard_pause'; reason = 'load_guard';
  assert.equal((await hd.readHdSystemAlerts('admin')).length, 0);
  checks.push('normal_manual_and_legacy_resource_wait_not_incidents');
  unavailable = true;
  assert.equal((await hd.readHdSystemAlerts('admin'))[0].id, 'hd_control_unavailable');
  checks.push('unknown_control_is_not_reported_healthy');
  unavailable = false; reason = 'worker_integrity_failure';

  let role: string | null = 'admin', writes = 0;
  const notifications = load('src/app/api/notifications/route.ts', {
    '@/lib/auth/session': { getSession: async () => role ? { id: 'fixture-actor', role } : null },
    '@/lib/prisma': { prisma: { notification: {
      findMany: async () => [], count: async () => 2,
      updateMany: async () => { writes++; return { count: 2 }; },
    } } }, '@/lib/notifications/hd-alert': hd,
  });
  const { NextRequest } = requireLocal('next/server');
  const invokeNotifications = () => notifications.GET(new NextRequest('https://isolated.invalid/api/notifications?unread=1'));
  let response = await invokeNotifications();
  let body = await response.json();
  assert.equal(body.unread_count, 2);
  assert.equal(body.notifications.length, 0);
  assert.equal(body.system_alerts.length, 1);
  assert.equal(writes, 0);
  assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
  checks.push('notification_get_keeps_ledger_count_and_performs_no_writes');
  await notifications.PATCH(new NextRequest('https://isolated.invalid/api/notifications', {
    method: 'PATCH', body: JSON.stringify({ action: 'mark_all_read' }),
    headers: { 'content-type': 'application/json' },
  }));
  response = await invokeNotifications(); body = await response.json();
  assert.equal(body.system_alerts.length, 1);
  checks.push('mark_all_read_cannot_clear_current_hard_pause');
  role = 'user';
  assert.equal((await (await invokeNotifications()).json()).system_alerts.length, 0);
  role = null;
  assert.equal((await invokeNotifications()).status, 401);
  checks.push('real_notification_route_keeps_admin_and_login_boundaries');

  let requestedStart = -1, observedDownloads = 0, allowed = true;
  const media = load('src/lib/works/media.ts', {
    'server-only': {}, '@/lib/prisma': { prisma: { asset: { findUnique: async () => { clock += 5; return { mime_type: 'image/png' }; } } } },
    '@/lib/media/authorized-image-response': { authorizedImageResponse: async (_request: Request, _source: string,
      _variant: string, _mime: string, _name: string | undefined, started: number) => {
      requestedStart = started;
      const access = clock - started; clock += 2;
      return new Response(null, { headers: { 'Server-Timing': `access;dur=${access},media;dur=2`, ETag: 'fixture-etag', 'X-Image-Source-Version': 'fixture-source' } });
    } },
    '@/lib/media/preview-response': {}, '@/lib/assets/site-url': {},
    './access': { getWorkAccess: async () => {
      clock += 40;
      return allowed ? { canPreview: true, canDownload: true, reuse: true,
        work: { id: 'fixture-work', medium: 'image', title: 'fixture' },
        media: { id: 'fixture-version', source_url: '/uploads/fixture.png', asset_id: 'fixture-asset' } } : null;
    } }, './preview-files': {}, './types': { WorkError: class extends Error {} },
    './http': { workHeaders: { 'Cache-Control': 'private, no-store' } },
    './recommendation-events': { observeWorkDownload: (_request: Request, output: Response) => {
      observedDownloads++; return output;
    } },
  });
  const route = load('src/app/api/works/[id]/media/route.ts', {
    '@/lib/works/media': media, '@/lib/works/operations': { workApiUser: async () => { clock += 25; return { id: 'fixture-actor' }; } },
    '@/lib/works/http': { workRouteError: () => new Response(null, { status: 404 }) },
  });
  for (const variant of ['hd', 'original', 'download', 'hd-download']) {
    clock = 1000;
    response = await route.HEAD(new Request(`https://isolated.invalid/api/works/fixture-work/media?version=fixture-version&variant=${variant}`, { method: 'HEAD' }), { params: { id: 'fixture-work' } });
    assert.equal(response.status, 200);
    assert.equal(requestedStart, 1000);
    const timing = response.headers.get('server-timing') || '';
    assert.match(timing, /access;dur=70/);
    assert.match(timing, /auth;dur=25\.0/);
    assert.match(timing, /work_access;dur=40\.0/);
    assert.equal(response.headers.get('etag'), 'fixture-etag');
    assert.equal(response.headers.get('x-image-source-version'), 'fixture-source');
    assert.equal(response.headers.get('x-work-media-version'), 'fixture-version');
    assert.equal(response.body, null);
  }
  assert.equal(observedDownloads, 2);
  checks.push('actual_GET_HEAD_chain_counts_auth_and_work_access_and_preserves_media_identity');
  checks.push('original_and_hd_download_observer_is_retained');
  allowed = false;
  const before = requestedStart;
  response = await route.GET(new Request('https://isolated.invalid/api/works/fixture-work/media?version=fixture-version&variant=hd'), { params: { id: 'fixture-work' } });
  assert.equal(response.status, 404);
  assert.equal(requestedStart, before);
  checks.push('denied_work_never_opens_media');
  console.log(JSON.stringify({ completed: true, checks, count: checks.length,
    scope: 'Offline actual source routes/projections with denied external dependencies; no DB files, services, network, providers or production state. Not browser acceptance.' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
