// Real React/provider lifecycle in isolated Chromium; loopback fixture responses only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const root = path.resolve(__dirname, '..');
const owner = 'fixture-owner', feedbackId = 'fixture-feedback';
const pendingKey = `sd2:feedback-action:v1:${owner}:${feedbackId}:author:1`;
const saved = JSON.stringify({ version: 1, draft: { summary: '', note: '原稿与原编号保留', result: 'needs_work', assets: [] },
  pending: { operationId: 'original-feedback-operation', round: 1, result: 'needs_work', note: '原稿与原编号保留', uploadedAssetIds: [], imageUrls: [] } });
const fixtureUser = id => ({ id, name: 'Fixture user', username: 'fixture', email: null, role: 'user' });
const results = [];
async function main() {
  const scratch = process.env.BUILD_SCRATCH_ROOT;
  if (scratch) { fs.mkdirSync(scratch, { recursive: true }); process.env.TMP = process.env.TEMP = process.env.TMPDIR = scratch; }
  const bundle = await build({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', write: false,
    jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"development"' },
    stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'feedback-session-fixture.tsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { AppSessionProvider } from '@/lib/context/AppSessionContext';
      import { FeedbackLifecyclePanel } from '@/components/feedback/FeedbackLifecyclePanel';
      import { lockClientSession } from '@/lib/auth/client-session-boundary';
      const root = createRoot(document.getElementById('root')!);
      window.mountFeedback = (props) => root.render(<React.StrictMode><AppSessionProvider><FeedbackLifecyclePanel {...props} /></AppSessionProvider></React.StrictMode>);
      window.lockFeedbackSession = () => lockClientSession('logged_out');
    ` },
    plugins: [{ name: 'unrelated-ui-leaves', setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      b.onResolve({ filter: /^@\/components\/(ResourceLibraryPicker|ZoomableImagePreview)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
      b.onResolve({ filter: /^@\/lib\/http\/file-upload$/ }, () => ({ path: 'upload', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: root, loader: 'jsx', contents:
        args.path === 'link' ? `import React from 'react'; export default function Link({href,...props}){return <a href={href} {...props}/>}` :
        args.path === 'upload' ? `export function uploadFileAsAsset(){throw new Error('No upload is authorized in this fixture')}` :
        `export function ${args.path}(){return null}` }));
      b.onLoad({ filter: /\.css$/ }, () => ({ loader: 'js', contents: 'export default new Proxy({}, {get:(_,key)=>String(key)})' }));
    } }],
  });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined, args: ['--disable-background-networking'] });
    async function scenario(name, options, run) {
      const context = await browser.newContext();
      const calls = [], errors = []; let authCalls = 0, releaseAuth;
      const authGate = options.holdAuth ? new Promise(resolve => { releaseAuth = resolve; }) : Promise.resolve();
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== base) { errors.push('Unexpected external request'); return route.abort(); }
          if (!url.pathname.startsWith('/api/')) return route.continue();
          calls.push({ path: url.pathname, method: request.method(), owner: request.headers()['x-app-session-user'] });
          if (request.method() !== 'GET') { errors.push('Unexpected write or notification'); return route.abort(); }
          if (url.pathname === '/api/auth/me') {
            authCalls++; await authGate;
            if (options.firstAuthFails && authCalls === 1) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
            return route.fulfill({ json: { user: options.signedOut ? null : fixtureUser(options.otherOwner ? 'different-owner' : owner) } });
          }
          assert.equal(url.pathname, `/api/feedback/${feedbackId}`);
          assert.equal(request.headers()['x-app-session-user'], owner);
          const round = options.pending ? { number: 1, summary: '修复记录', publishedAt: 1, review: null, delivery: { status: 'pending', error: null } } : null;
          return route.fulfill({ json: { feedback: { content: '本人反馈内容', created_at: '2026-11-01T00:00:00.000Z', image_urls_json: '[]' },
            revision: 1, currentRound: round ? 1 : 0, receivedAt: 1, round } });
        });
        const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
        await page.goto(base); await page.waitForFunction(() => typeof window.mountFeedback === 'function');
        if (options.pending) await page.evaluate(({key,value}) => localStorage.setItem(key,value), { key: pendingKey, value: saved });
        await page.evaluate(({owner,feedbackId,pending}) => window.mountFeedback({ owner, feedbackId, ...(pending ? { initialRound: 1 } : {}) }), { owner, feedbackId, pending: options.pending });
        const feedbackCalls = () => calls.filter(c => c.path.startsWith('/api/feedback/'));
        await run({ page, calls, feedbackCalls, releaseAuth, authCalls: () => authCalls });
        assert.deepEqual(errors, []); assert.ok(calls.every(c => c.method === 'GET'));
        if (options.pending) assert.equal(await page.evaluate(key => localStorage.getItem(key), pendingKey), saved);
        results.push({ name, passed: true });
      } catch (error) { results.push({ name, passed: false, error: error.message }); }
      finally { releaseAuth?.(); await context.close(); }
    }
    await scenario('direct link initializes the real shared session once under StrictMode', { holdAuth: true }, async ({page, feedbackCalls, releaseAuth, authCalls}) => {
      await page.getByText('正在核对登录状态…', { exact: true }).waitFor();
      assert.equal(feedbackCalls().length, 0); releaseAuth();
      await page.getByText('本人反馈内容', { exact: true }).waitFor();
      assert.equal(authCalls(), 1); assert.equal(feedbackCalls().length, 1);
    });
    await scenario('failed identity read exposes retry and preserves the frozen original operation', { firstAuthFails: true, pending: true }, async ({page, feedbackCalls, authCalls}) => {
      await page.getByRole('button', { name: '重新确认登录', exact: true }).waitFor();
      assert.equal(feedbackCalls().length, 0);
      await page.getByRole('button', { name: '重新确认登录', exact: true }).click();
      await page.getByText('本人反馈内容', { exact: true }).waitFor();
      assert.equal(authCalls(), 2); assert.equal(feedbackCalls().length, 1);
      await page.getByRole('button', { name: '继续核对原回测', exact: true }).waitFor();
    });
    await scenario('a different account never reads the original owner feedback or reveals its draft', { otherOwner: true, pending: true }, async ({page, feedbackCalls}) => {
      await page.getByText('当前账号与打开此页时不同，请返回反馈列表重新打开。', { exact: false }).waitFor();
      assert.equal(feedbackCalls().length, 0);
      assert.equal(await page.getByText('本人反馈内容', { exact: true }).count(), 0);
      assert.equal(await page.locator('textarea').count(), 0);
    });
    await scenario('signed out state gives a recoverable login link without sending', { signedOut: true, pending: true }, async ({page, feedbackCalls}) => {
      const link = page.getByRole('link', { name: '前往登录', exact: true }); await link.waitFor();
      assert.equal(new URL(await link.getAttribute('href'), base).searchParams.get('next'), `/feedback/${feedbackId}?round=1`);
      assert.equal(feedbackCalls().length, 0);
    });
    await scenario('a session exit blocks automatic identity recovery and keeps the original draft', { pending: true }, async ({page, calls, feedbackCalls, authCalls}) => {
      await page.getByText('本人反馈内容', { exact: true }).waitFor();
      const before = calls.length; await page.evaluate(() => window.lockFeedbackSession());
      await page.locator('p').filter({ hasText: '登录状态已变化，当前反馈已暂停。' }).waitFor();
      assert.equal(authCalls(), 1); assert.equal(feedbackCalls().length, 1); assert.equal(calls.length, before);
      assert.equal(await page.getByText('本人反馈内容', { exact: true }).count(), 0);
    });
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
  console.log(JSON.stringify({ ok: results.every(r => r.passed), results }, null, 2));
  assert.ok(results.every(r => r.passed), 'Collect the whole batch before applying corrections');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
