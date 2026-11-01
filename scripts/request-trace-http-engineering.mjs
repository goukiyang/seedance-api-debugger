import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = process.cwd(), destination = process.argv[2];
assert.ok(destination && path.isAbsolute(destination));
const privateRoot = path.dirname(destination);
const sources = ['src/middleware.ts', 'src/lib/performance/request-trace.ts', 'src/lib/performance/trace-contract.ts', 'scripts/request-trace-http-engineering.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await Promise.all(sources.map(file => fs.readFile(path.join(root, file))));
const sourceSha256 = Object.fromEntries(sources.map((file, index) => [file, digest(sourceBytes[index])]));
const copiedSourceSha256 = {};
const directory = await fs.mkdtemp(path.join(tmpdir(), 'sd2-request-trace-http-'));
const write = async (name, value) => { const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
let log = '', child, exit, stopPromise, stopped = false, failure, proof;
let phase = 'prepare', ready = false, readyTimer, readyElapsedMs = null;
const cleanupErrors = [];
const stop = () => stopPromise ??= (async () => {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    // Reuse the promise attached at spawn; never subscribe after an exit.
    await exit;
  }
  stopped = child.exitCode !== null || child.signalCode !== null;
  assert.ok(stopped || !child.pid, 'Fixture child exit was not confirmed');
})();
try {
  for (let index = 0; index < sources.length - 1; index++) {
    const file = sources[index];
    await write(file, sourceBytes[index]);
    copiedSourceSha256[file] = digest(await fs.readFile(path.join(directory, file)));
    assert.equal(copiedSourceSha256[file], sourceSha256[file], `Fixture copy differs: ${file}`);
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  await write('package.json', JSON.stringify({ name: 'trace-http-fixture', private: true, version: '1.0.0' }));
  await write('next.config.js', 'module.exports = {};\n');
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'esnext'], module: 'esnext', moduleResolution: 'node', jsx: 'preserve', strict: true, esModuleInterop: true, skipLibCheck: true, baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
  await write('src/app/layout.tsx', 'export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }\n');
  await write('src/app/page.tsx', 'export default function Page() { return <p>fixture-ready</p>; }\n');
  await write('src/app/admin/page.tsx', "import { headers } from 'next/headers'; import { traceServerRequest } from '@/lib/performance/request-trace'; export default async function Page() { return traceServerRequest('admin.page', headers(), async () => <p>fixture-ssr</p>); }\n");
  await write('src/app/api/image-studio/settings/route.ts', "import { NextRequest } from 'next/server'; import { traceHttpRequest, tracePhase } from '@/lib/performance/request-trace'; export async function GET(request: NextRequest) { return traceHttpRequest('studio.settings', request.headers, async () => { await tracePhase('auth', async () => undefined); if(request.nextUrl.searchParams.has('fail')) throw new Error('synthetic_trace_failure'); return new Response('fixture-ok', {status:207, headers:{'Cache-Control':'private, no-store'}}); }); }\n");
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  phase = 'next-startup';
  const startedAt = Date.now(), deadline = startedAt + 60000;
  let resolveReady, rejectReady;
  const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', directory, '-H', '127.0.0.1', '-p', String(port)], { cwd: directory, detached: true, env: { PATH: process.env.PATH, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      if (!ready) rejectReady(new Error(`Fixture Next exited before Ready (code=${code}, signal=${signal})`));
      resolve({ code, signal });
    });
    child.once('error', error => { rejectReady(error); resolve({ error }); });
  });
  const capture = data => {
    log += data;
    if (!ready && /\bReady in\s+[\d.]+\s*(?:ms|s)\b/.test(log.replace(/\u001b\[[0-9;]*m/g, ''))) {
      ready = true; readyElapsedMs = Date.now() - startedAt; clearTimeout(readyTimer); resolveReady();
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  readyTimer = setTimeout(() => rejectReady(new Error('Fixture Next server did not report Ready within startup budget')), Math.max(1, deadline - Date.now()));
  await readiness; clearTimeout(readyTimer);
  phase = 'fixture-route-readiness';
  const origin = `http://127.0.0.1:${port}`;
  // A single route check shares the original startup budget. Compilation/404
  // after Ready is a route failure rather than hundreds of startup retries.
  const health = await fetch(origin, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
  assert.equal(health.status, 200, 'Next reported Ready, but fixture / failed');
  assert.match(await health.text(), /fixture-ready/);
  phase = 'http-assertions';
  const supplied = '11111111-1111-4111-8111-111111111111', requestHeaders = { 'x-sd2-request-id': supplied, cookie: 'session=synthetic_not_a_credential' };
  const success = await fetch(origin + '/api/image-studio/settings', { headers: requestHeaders, signal: AbortSignal.timeout(30000) });
  const successId = success.headers.get('x-sd2-request-id'); assert.equal(success.status, 207); assert.equal(await success.text(), 'fixture-ok'); assert.equal(success.headers.get('Cache-Control'), 'private, no-store'); assert.ok(successId && successId !== supplied);
  const failureResponse = await fetch(origin + '/api/image-studio/settings?fail=1', { headers: requestHeaders, signal: AbortSignal.timeout(10000) });
  const failureId = failureResponse.headers.get('x-sd2-request-id'); assert.equal(failureResponse.status, 500); assert.ok(failureId && failureId !== supplied); await failureResponse.arrayBuffer();
  const ssr = await fetch(origin + '/admin', { headers: requestHeaders, signal: AbortSignal.timeout(30000) }); const ssrId = ssr.headers.get('x-sd2-request-id'); assert.equal(ssr.status, 200); assert.match(await ssr.text(), /fixture-ssr/); assert.ok(ssrId && ssrId !== supplied);
  const denied = await fetch(origin + '/admin', { redirect: 'manual', signal: AbortSignal.timeout(10000) }); assert.equal(denied.status, 307); assert.match(denied.headers.get('location'), /\/login\?next=%2Fadmin/); assert.ok(denied.headers.get('x-sd2-request-id'));
  const traces = log.split('\n').filter(line => line.startsWith('[RequestTrace] ')).map(line => JSON.parse(line.slice('[RequestTrace] '.length)));
  assert.ok(traces.some(row => row.requestId === successId && row.event === 'response-ready' && row.status === 207));
  assert.ok(traces.some(row => row.requestId === failureId && row.event === 'request-threw'));
  assert.ok(traces.some(row => row.requestId === ssrId && row.event === 'server-complete'));
  assert.ok(!JSON.stringify(traces).includes('synthetic_not_a_credential'));
  for (const file of sources) assert.equal(digest(await fs.readFile(path.join(root, file))), sourceSha256[file], `Source changed during fixture: ${file}`);
  proof = { sourceSha256, copiedSourceSha256, nextReady: ready, nextReadyElapsedMs: readyElapsedMs, fixtureRouteReady: true };
} catch (error) {
  failure = error;
  console.error('HTTP_FIXTURE_FAILED', { phase, nextReady: ready, nextReadyElapsedMs: readyElapsedMs }, error);
} finally {
  clearTimeout(readyTimer);
  try { await stop(); } catch (error) { cleanupErrors.push(error); console.error('HTTP_FIXTURE_CLEANUP_FAILED', 'child-stop', error); }
  try { await fs.writeFile(path.join(privateRoot, 'stage1-http-engineering.log'), log, { mode: 0o600 }); }
  catch (error) { cleanupErrors.push(error); console.error('HTTP_FIXTURE_CLEANUP_FAILED', 'log-write', error); }
  try { await fs.rm(directory, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); console.error('HTTP_FIXTURE_CLEANUP_FAILED', 'directory-remove', error); }
}
if (failure) throw failure;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'HTTP fixture cleanup failed');
assert.ok(proof && stopped, 'HTTP fixture did not complete and stop its child');
await fs.writeFile(destination, JSON.stringify({ completed: true, actualNextHttp: true, checks: ['middleware_forwarded_id_matches_success_node_trace', 'unhandled500_preserves_client_id_and_node_error_context', 'SSR_id_matches_server_context', 'original_missing_cookie_login_redirect_retained', 'incoming_trace_id_replaced', 'response_status_body_cache_unchanged'], ...proof, productionRequests: 0, applicationDatabaseLoaded: false, creditsRequests: 0, businessCodeHandlersLoaded: false, fixtureServerStopped: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ completed: true, receipt: destination, actualNextHttp: true, fixtureServerStopped: true }));
