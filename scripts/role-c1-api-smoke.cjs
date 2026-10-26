'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function main() {
  const fixturePath = fs.realpathSync(process.argv[2] || '');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.synthetic !== true || fixture.root !== process.cwd() || !fixturePath.startsWith(path.resolve('.role-tests') + path.sep)) {
    throw new Error('Only a local synthetic fixture may be tested');
  }
  const port = Number(process.argv[3] || 3327), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve('scripts/role-c1-ui-serve.cjs'), fixturePath, String(port)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = path.join(fixture.directory, 'api-next.log');
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  child.stdout.pipe(log); child.stderr.pipe(log);
  let exited = false;
  const stopped = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Owned isolated Next did not become ready; inspect private api-next.log')), 120000);
    child.stdout.on('data', data => {
      output = (output + String(data)).slice(-8192);
      // Do not send the synthetic cookie until OUR child has actually bound the port.
      if (/Ready in /.test(output)) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('Owned isolated Next exited before readiness')); });
  });
  const checks = [];
  const check = async (name, action) => {
    try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { checks.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const request = async (endpoint, options = {}) => {
    const response = await fetch(base + endpoint, { ...options, redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { Cookie: `session=${fixture.sessionToken}`, ...(options.method ? { 'Content-Type': 'application/json', Origin: base } : {}),
        ...options.headers } });
    let body; try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body, cache: response.headers.get('cache-control'), location: response.headers.get('location') };
  };
  try {
    await ready;
    await check('Actual role route rejects anonymous session and cross-site writes', async () => {
      const anonymous = await request('/api/tools/ultimate-canvas/roles', { headers: { Cookie: '' } });
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.cache, /no-store/);
      const cross = await request('/api/tools/ultimate-canvas/roles', { method: 'POST', body: '{}',
        headers: { Origin: 'https://external.invalid', 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(cross.status, 403); assert.equal(cross.body.code, 'invalid_origin');
    });
    await check('Actual canvas page and bootstrap use synthetic bound account, not a demo', async () => {
      const page = await fetch(base + fixture.pagePath, { headers: { Cookie: `session=${fixture.sessionToken}` }, redirect: 'manual' });
      assert.equal(page.status, 200); assert.match(await page.text(), /ultimate-canvas/);
      const bootstrap = await request('/api/tools/ultimate-canvas/bootstrap?project_id=' + fixture.projectId);
      assert.equal(bootstrap.status, 200); assert.equal(bootstrap.body.user.id, fixture.ownerId);
      assert.equal(bootstrap.body.backend.mock, false);
    });
    await check('Actual role create and persistent receipt replay once, then join saved canvas', async () => {
      const payload = { mutation_id: randomUUID(), snapshot: { schema: 'role.v1', name: 'API合成角色', responsibilities: '只处理合成文字',
        delivery: '合成成果', criteria: '', boundary: '不外发', executor: { kind: 'person', userId: fixture.ownerId }, tools: ['manual'], requiredItems: [] } };
      const created = await request('/api/tools/ultimate-canvas/roles', { method: 'POST', body: JSON.stringify(payload) });
      assert.equal(created.status, 200); assert.ok(created.body.role.id);
      const replay = await request('/api/tools/ultimate-canvas/roles', { method: 'POST', body: JSON.stringify(payload) });
      assert.equal(replay.status, 200); assert.equal(replay.body.role.id, created.body.role.id); assert.equal(replay.body.replayed, true);
      const receipt = await request('/api/tools/ultimate-canvas/role-receipts/' + payload.mutation_id);
      assert.equal(receipt.status, 200); assert.equal(receipt.body.role.id, created.body.role.id);
      const current = await request('/api/tools/ultimate-canvas/document?document_id=' + fixture.documentId,
        { headers: { 'x-canvas-capabilities': 'role.v1' } });
      assert.equal(current.status, 200);
      const join = { mutation_id: randomUUID(), document_id: fixture.documentId, document_revision: current.body.document.revision,
        definition_id: created.body.role.id, version: 1, position: { x: 460, y: 550 }, pending_connection: null };
      const joined = await request('/api/tools/ultimate-canvas/role-join', { method: 'POST', body: JSON.stringify(join) });
      assert.equal(joined.status, 200); assert.ok(joined.body.nodeId);
      const joinedAgain = await request('/api/tools/ultimate-canvas/role-join', { method: 'POST', body: JSON.stringify(join) });
      assert.equal(joinedAgain.status, 200); assert.equal(joinedAgain.body.nodeId, joined.body.nodeId);
      const old = await request('/api/tools/ultimate-canvas/document?document_id=' + fixture.documentId);
      assert.equal(old.status, 426);
    });
    await check('Actual role API rejects oversized body before any role mutation', async () => {
      const response = await request('/api/tools/ultimate-canvas/roles', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(513 * 1024) }) });
      assert.equal(response.status, 413);
    });
    await check('Actual AI gate gives an unavailable reason without provider configuration', async () => {
      const detail = await request('/api/tools/ultimate-canvas/role-work/' + fixture.workIds[2]);
      assert.equal(detail.status, 200); assert.equal(detail.body.execution.enabled, false);
      assert.ok(detail.body.execution.reason);
      assert.equal(detail.body.attempts.length, 0);
    });
    await check('Actual fixed delivery file route preserves authored original bytes and session checks', async () => {
      const detail = await request('/api/tools/ultimate-canvas/role-work/' + fixture.workIds[0]);
      assert.equal(detail.status, 200);
      const delivery = detail.body.deliveries.find(row => row.id === detail.body.work.current_delivery_id);
      assert.ok(delivery);
      const endpoint = `/api/tools/ultimate-canvas/role-deliveries/${delivery.id}/attachments/0`;
      const anonymous = await request(endpoint, { headers: { Cookie: '' } });
      assert.equal(anonymous.status, 401);
      const original = await fetch(base + endpoint + '?url=https%3A%2F%2Fexternal.invalid%2Fnot-an-original', {
        headers: { Cookie: `session=${fixture.sessionToken}` }, redirect: 'manual' });
      assert.equal(original.status, 200);
      assert.match(original.headers.get('content-type'), /^text\/plain/);
      assert.match(original.headers.get('cache-control'), /no-store/);
      assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
      assert.match(original.headers.get('content-security-policy'), /sandbox/);
      assert.equal(await original.text(), '  synthetic original file\nline two\n');
      const head = await fetch(base + endpoint, { method: 'HEAD', headers: { Cookie: `session=${fixture.sessionToken}` } });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      const missing = await request(endpoint.replace('/0', '/1')); assert.equal(missing.status, 404);
      const invalid = await request(endpoint.replace('/0', '/20')); assert.equal(invalid.status, 400);
    });
    await check('Actual original-attempt GET and independent pagination reach history beyond30 without sending', async () => {
      const endpoint = '/api/tools/ultimate-canvas/role-work/' + fixture.workIds[0];
      const first = await request(endpoint); assert.equal(first.status, 200);
      assert.equal(first.body.attempts.length, 30); assert.ok(first.body.next_attempt_cursor);
      assert.equal(first.body.attempts[0].result_json, undefined);
      assert.equal(first.body.attempts[0].result_available, true);
      const second = await request(endpoint + '?attempt_cursor=' + first.body.next_attempt_cursor);
      assert.equal(second.status, 200); assert.equal(second.body.attempts.length, 1); assert.equal(second.body.next_attempt_cursor, null);
      assert.equal(second.body.next_cursor, first.body.next_cursor);
      assert.equal(second.body.next_work_cursor, first.body.next_work_cursor);
      const attempt = second.body.attempts[0];
      const original = await request('/api/tools/ultimate-canvas/role-attempts/' + attempt.id);
      assert.equal(original.status, 200); assert.equal(original.body.attempt.work_id, fixture.workIds[0]);
      assert.match(JSON.parse(original.body.attempt.result_json).text, /Synthetic historical advice/);
      assert.equal(original.body.attempt.quote_json, undefined); assert.equal(original.body.attempt.input_snapshot_json, undefined);
      const anonymous = await request('/api/tools/ultimate-canvas/role-attempts/' + attempt.id, { headers: { Cookie: '' } });
      assert.equal(anonymous.status, 401);
      const wrongScope = await request('/api/tools/ultimate-canvas/role-work/' + fixture.workIds[2] + '?attempt_cursor=' + attempt.id);
      assert.equal(wrongScope.status, 400);
    });
  } finally {
    if (!exited) child.kill('SIGINT');
    await stopped; log.end();
    fs.writeFileSync(path.join(fixture.directory, 'api-receipt.json'), JSON.stringify({ syntheticOnly: true,
      productionWrites: 0, providerRequests: 0, browserRuns: 0, ownedNextStopped: true, checks }, null, 2), { mode: 0o600 });
  }
  if (checks.some(check => !check.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
