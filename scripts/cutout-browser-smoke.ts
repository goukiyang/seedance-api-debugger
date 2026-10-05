import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const localRequire = createRequire(path.join(root, 'package.json'));
const output = process.env.CUTOUT_EVIDENCE_DIR;
const entry = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Page from './src/app/cutout/page';
import CharacterBoxEditor from './src/components/cutout/CharacterBoxEditor';
import RegionSelector from './src/components/cutout/RegionSelector';
import BrushRepair from './src/components/cutout/BrushRepair';
import { getPageExitRisk } from './src/lib/hooks/page-exit-guard';
import './src/app/globals.css';
function Editors() {
  const [boxes, setBoxes] = useState([]), [prompts, setPrompts] = useState([]), [region, setRegion] = useState(null);
  return <main style={{padding:16}}><CharacterBoxEditor imageUrl='/original.png' width={400} height={240} boxes={boxes} onBoxesChange={setBoxes} prompts={prompts} onPromptsChange={setPrompts}/>
    <output style={{display:'none'}} data-testid='boxes'>{JSON.stringify(boxes)}</output><output style={{display:'none'}} data-testid='prompts'>{JSON.stringify(prompts)}</output>
    <RegionSelector imageUrl='/original.png' width={400} height={240} value={region} onChange={setRegion}/><output style={{display:'none'}} data-testid='region'>{JSON.stringify(region)}</output>
    <BrushRepair resultUrl='/result.png' originalUrl='/original.png' onApply={async (png, mask) => {
      if (window.failApply) throw Error('模拟保存失败');
      window.applied = [Array.from(new Uint8Array(await png.arrayBuffer())), Array.from(new Uint8Array(await mask.arrayBuffer()))];
    }}/><button data-testid='risk' onClick={() => {window.exitRisk=getPageExitRisk();}}>read risk</button></main>;
}
createRoot(document.getElementById('root')).render(location.pathname === '/editors' ? <Editors/> : <Page/>);
`;

async function main() {
  let browser: any, server: http.Server | undefined;
  const errors: string[] = [], external: string[] = [], requests: Array<{ method: string; path: string; body?: any; retryKey?: string }> = [];
  let checks = 0;
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
  try {
    const esbuild = localRequire('esbuild'), sharp = localRequire('sharp');
    const built = await esbuild.build({ absWorkingDir: root, stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false,
      outfile: '/tmp/cutout-fixture.js', platform: 'browser', format: 'iife', target: ['chrome120'], jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'local-css' }, logLevel: 'silent',
      plugins: [{ name: 'fixture-next-link', setup(build: any) {
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture-link' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture-link' }, () => ({ contents: "import React from 'react'; export default function Link({href,prefetch,replace,scroll,...props}){return <a href={typeof href==='string'?href:href.pathname} {...props}/>}", loader: 'jsx', resolveDir: root }));
      } }] });
    const js = built.outputFiles.find((item: any) => item.path.endsWith('.js'))?.text;
    const css = built.outputFiles.find((item: any) => item.path.endsWith('.css'))?.text;
    check(js && css, 'real CUT components and CSS bundled');
    const originalPixels = Buffer.alloc(400 * 240 * 4), resultPixels = Buffer.alloc(400 * 240 * 4);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4, subject = x > 80 && x < 320 && y > 40 && y < 200;
      originalPixels.set(subject ? [200, 55, 65, 255] : [235, 238, 240, 255], i);
      resultPixels.set(subject ? [200, 55, 65, 255] : [235, 238, 240, 0], i);
    }
    const original = await sharp(originalPixels, { raw: { width: 400, height: 240, channels: 4 } }).png().toBuffer();
    const result = await sharp(resultPixels, { raw: { width: 400, height: 240, channels: 4 } }).png().toBuffer();
    server = http.createServer((req, res) => {
      if (req.url === '/bundle.js' || req.url === '/bundle.css') { res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(req.url.endsWith('.js') ? js : css); }
      else if (req.url === '/original.png' || req.url === '/result.png') { res.setHeader('content-type', 'image/png'); res.end(req.url === '/original.png' ? original : result); }
      else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = localRequire(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    let ready = false, failSubmission = false;
    await context.route('**/*', async (route: any) => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin && !url.protocol.startsWith('data') && url.protocol !== 'blob:') { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests.push({ method: req.method(), path: url.pathname, body: req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : undefined, retryKey: req.headers()['idempotency-key'] });
      const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/auth/me') return reply({ success: true, user: { id: 'fixture-admin', role: 'admin', username: 'fixture' } });
      if (url.pathname.endsWith('/capabilities')) return reply({ success: true, models: [{ id: 'birefnet', available: true }, { id: 'missing', available: false }], worker: { online: true }, dispatch: { available: true }, limits: { max_upload_mb: 15 }, integration: { configured: ready, authorized: ready, ready, message: ready ? '抠图服务已就绪' : '当前账户尚未绑定业务授权，不能提交任务' } });
      if (url.pathname.endsWith('/jobs/history')) return reply({ items: failSubmission ? [{ job_id: 'fixture-history', kind: 'cutout', status: 'succeeded', created_at: Date.now()/1000, result: { result_url: '/api/cutout/v1/results/fixture-history/result.png' } }] : [], total: failSubmission ? 1 : 0, limit: 12, offset: 0 });
      if (url.pathname.endsWith('/assets')) return reply({ asset_id: 'fixture-asset', width: 400, height: 240 }, 201);
      if (url.pathname.endsWith('/jobs') && req.method() === 'POST') {
        if (failSubmission) return route.abort('connectionfailed');
        return reply({ job_id: 'fixture-job', kind: 'cutout', status: 'queued', created_at: Date.now()/1000 }, 202);
      }
      if (url.pathname.endsWith('/jobs/fixture-job')) return reply({ job_id: 'fixture-job', kind: 'cutout', status: 'succeeded', created_at: Date.now()/1000, result: { filename: 'result.png', result_url: '/api/cutout/v1/results/fixture-job/result.png', mask_url: '/api/cutout/v1/results/fixture-job/mask.png', crop: { x: 0, y: 0, width: 400, height: 240 } } });
      if (url.pathname.endsWith('/jobs/fixture-history')) return reply({ job_id: 'fixture-history', kind: 'cutout', status: 'succeeded', created_at: Date.now()/1000, result: { result_url: '/api/cutout/v1/results/fixture-history/result.png' } });
      if (url.pathname.includes('/results/')) return route.fulfill({ status: 200, contentType: 'image/png', body: result });
      return reply({ success: true });
    });
    const page = await context.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${origin}/editors`);
    await page.getByRole('img', { name: '角色原图', exact: true }).waitFor();
    await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth));
    const overlay = page.locator('svg[aria-label="角色框选区域"]'), bounds = await overlay.boundingBox(); check(bounds, 'actual image overlay visible');
    await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height * .1); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .7); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=boxes]')!.textContent!).length === 1);
    const box = JSON.parse(await page.getByTestId('boxes').textContent())[0];
    check(Math.abs(box.x - 40) <= 1 && Math.abs(box.y - 24) <= 1 && Math.abs(box.w - 200) <= 1 && Math.abs(box.h - 144) <= 1, 'natural-pixel coordinates, no letterbox offset');
    const character = page.getByRole('region', { name: '角色框与提示点编辑器' });
    await character.getByRole('button', { name: '撤销', exact: true }).click(); check(JSON.parse(await page.getByTestId('boxes').textContent()).length === 0, 'box undo');
    await character.getByRole('button', { name: '重做', exact: true }).click(); check(JSON.parse(await page.getByTestId('boxes').textContent()).length === 1, 'box redo');
    await character.getByRole('button', { name: '前景点', exact: true }).click();
    await overlay.click({ position: { x: bounds.width * .3, y: bounds.height * .3 } });
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=prompts]')!.textContent!).length === 1);
    const prompt = JSON.parse(await page.getByTestId('prompts').textContent())[0];
    check(prompt.id === box.id && prompt.labels[0] === 1 && Math.abs(prompt.points[0][0] - 120) <= 1, 'foreground points retain exact role ID and natural coordinates');
    await character.getByRole('button', { name: '撤销', exact: true }).click(); check(JSON.parse(await page.getByTestId('prompts').textContent()).length === 0, 'points participate in undo');
    const regionOverlay = page.locator('svg[aria-label="拆分范围框选区域"]');
    await regionOverlay.scrollIntoViewIfNeeded(); const rb = await regionOverlay.boundingBox(); check(rb, 'region overlay visible');
    await page.mouse.move(rb.x + rb.width * .2, rb.y + rb.height * .25); await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * .8, rb.y + rb.height * .75); await page.mouse.up();
    const selectedRegion = JSON.parse(await page.getByTestId('region').textContent());
    check(selectedRegion.x === 80 && selectedRegion.y === 60 && selectedRegion.w === 240 && selectedRegion.h === 120, 'continuation region uses original pixel bounds');
    await page.getByRole('button', { name: '清除选区', exact: true }).click(); check(await page.getByTestId('region').textContent() === 'null', 'clear affects selection only');
    const brush = page.getByRole('region', { name: '画笔修复编辑器' });
    await brush.getByRole('button', { name: '擦除', exact: true }).click();
    const canvas = brush.locator('canvas'); await canvas.scrollIntoViewIfNeeded(); const cb = await canvas.boundingBox(); check(cb, 'brush canvas visible');
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.getByTestId('risk').click(); check((await page.evaluate(() => (window as any).exitRisk.unsaved)).length > 0, 'dirty brush protects refresh');
    await page.evaluate(() => { (window as any).failApply = true; }); await brush.getByRole('button', { name: '应用修复', exact: true }).click();
    await brush.getByText('模拟保存失败').waitFor(); check(await brush.getByRole('button', { name: '应用修复', exact: true }).isEnabled(), 'failed apply retains draft and retry');
    await page.evaluate(() => { (window as any).failApply = false; }); await brush.getByRole('button', { name: '应用修复', exact: true }).click();
    await page.waitForFunction(() => Boolean((window as any).applied));
    const exports = await page.evaluate(() => (window as any).applied);
    const png = await sharp(Buffer.from(exports[0])).ensureAlpha().raw().toBuffer(), mask = await sharp(Buffer.from(exports[1])).ensureAlpha().raw().toBuffer();
    const center = (120 * 400 + 200) * 4;
    check(png[center + 3] === 0 && mask[center] === 0 && mask[center + 3] === 255, 'exported PNG alpha and opaque mask match edited pixels');
    check(png[(80 * 400 + 100) * 4 + 3] === 255, 'brush does not erase unrelated subject pixels');
    await page.getByTestId('risk').evaluate((element: HTMLElement) => { element.style.display = 'none'; });
    if (output) { fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'editors-desktop.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile editors no horizontal overflow');
    if (output) await page.screenshot({ path: path.join(output, 'editors-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.goto(`${origin}/cutout`);
    await page.getByText('抠图服务尚未完成接入，任务操作暂不可用。', { exact: true }).waitFor();
    check(requests.filter(r => r.method === 'POST').length === 0, 'unconfigured page never uploads or submits');
    check(await page.getByRole('slider').count() >= 6, 'six controls present in original entry');
    ready = true;
    await page.getByRole('button', { name: '重新检查服务', exact: true }).click();
    await page.getByText('抠图服务已就绪', { exact: true }).waitFor();
    await page.evaluate(async () => {
      const blob = await (await fetch('/original.png')).blob(), data = new DataTransfer();
      data.items.add(new File([blob], 'pasted-fixture.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    });
    await page.getByText('pasted-fixture.png', { exact: true }).waitFor();
    check(requests.filter(r => r.method === 'POST').length === 0, 'paste creates local preview only');
    await page.getByRole('button', { name: '清除', exact: true }).click();
    await page.getByText('pasted-fixture.png', { exact: true }).waitFor({ state: 'hidden' });
    check(await page.getByRole('button', { name: '开始普通抠图', exact: true }).isDisabled(), 'clear really removes source');
    await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: original });
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('开始普通抠图')) as HTMLButtonElement)?.disabled);
    const slider = page.getByRole('slider').first(); await slider.focus(); await slider.press('ArrowRight');
    const savedValue = await slider.inputValue();
    await page.getByRole('button', { name: '开始普通抠图', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await page.getByRole('img', { name: '抠图结果', exact: true }).waitFor();
    const submissions = () => requests.filter(r => r.path.endsWith('/jobs') && r.method === 'POST');
    check(requests.filter(r => r.path.endsWith('/assets') && r.method === 'POST').length === 1 && submissions().length === 1, 'same-tick double click uploads and submits only once');
    check(Boolean(submissions()[0].retryKey) && submissions()[0].body.parameters.settings.background_removal === Number(savedValue), 'actual controls feed job payload with retry identity');
    const submittedBeforeRefresh = submissions().length;
    page.on('dialog', async (dialog: any) => { await dialog.accept(); });
    await page.reload(); await page.getByRole('img', { name: '抠图结果', exact: true }).waitFor();
    check(submissions().length === submittedBeforeRefresh && await page.getByRole('slider').first().inputValue() === savedValue, 'refresh restores settings and task via GET only');
    failSubmission = true;
    await page.locator('input[type=file]').setInputFiles({ name: 'uncertain-fixture.png', mimeType: 'image/png', buffer: original });
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('开始普通抠图')) as HTMLButtonElement)?.disabled);
    await page.getByRole('button', { name: '开始普通抠图', exact: true }).click();
    await page.getByRole('button', { name: '重试确认提交', exact: true }).waitFor();
    const uncertain = submissions().at(-1)!;
    const countBeforeReload = submissions().length;
    await page.reload(); await page.getByRole('button', { name: '重试确认提交', exact: true }).waitFor();
    check(submissions().length === countBeforeReload, 'uncertain draft restored without automatic POST');
    await page.locator('[role="button"][aria-disabled]').click();
    await page.waitForFunction(() => document.querySelector('img[alt="抠图结果"]')?.getAttribute('src')?.includes('fixture-history'));
    check(submissions().length === countBeforeReload && await page.getByRole('button', { name: '重试确认提交', exact: true }).isVisible(), 'uncertain submission permits read-only history without losing retry identity');
    failSubmission = false;
    await page.getByRole('button', { name: '重试确认提交', exact: true }).click();
    await page.getByRole('button', { name: '重试确认提交', exact: true }).waitFor({ state: 'hidden' });
    const retried = submissions().at(-1)!;
    check(retried.retryKey === uncertain.retryKey && JSON.stringify(retried.body) === JSON.stringify(uncertain.body), 'explicit recovery reuses exact key, asset and parameters after refresh');
    await page.getByRole('img', { name: '抠图结果', exact: true }).waitFor();
    if (output) await page.screenshot({ path: path.join(output, 'cutout-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile no horizontal overflow');
    if (output) await page.screenshot({ path: path.join(output, 'cutout-mobile.png'), fullPage: true });
    check(errors.length === 0, `no component runtime errors: ${errors.join('; ')}`); check(external.length === 0, 'no external site or paid jobs contacted');
    const report = { passed: true, checks, scope: 'isolated real components with synthetic PNG and mocked API, not provider acceptance', realImageJobs: 0, fees: 0, externalRequests: external.length };
    if (output) fs.writeFileSync(path.join(output, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
