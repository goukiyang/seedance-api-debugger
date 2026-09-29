import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const timeoutMs = 5000;

function log(message: string) {
  console.log(`[image-preview-drag-browser-smoke] ${message}`);
}

function baselineSource() {
  const ref = process.env.BASELINE_REF?.trim();
  if (!ref) return { source: null as string | null, label: 'working tree' };
  const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    cwd: root, encoding: 'utf8',
  });
  if (resolved.status !== 0) throw new Error(`BASELINE_REF is not a commit: ${ref}`);
  const commit = resolved.stdout.trim();
  const shown = spawnSync('git', ['show', `${commit}:src/components/ZoomableImagePreview.tsx`], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (shown.status !== 0 || !shown.stdout) throw new Error(`Could not load component from ${commit}`);
  return { source: shown.stdout, label: `${ref} (${commit.slice(0, 12)})` };
}

function harnessEntry() {
  const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#c44"/><circle cx="240" cy="160" r="90" fill="#fc6"/></svg>')}`;
  return `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ZoomableImagePreview } from './src/components/ZoomableImagePreview';
const image = ${JSON.stringify(image)};
function Harness() {
  const [open, setOpen] = useState(true);
  return <><button data-testid="open" onClick={() => setOpen(true)}>打开预览</button>
    {open && <ZoomableImagePreview src={image} alt="fixture" title="drag fixture" comparison={{src: image, alt: 'reference fixture'}} onClose={() => setOpen(false)} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
`;
}

async function bundle(esbuild: any, componentSource: string | null) {
  const result = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: harnessEntry(), loader: 'tsx', resolveDir: root, sourcefile: 'image-preview-drag-harness.tsx' },
    bundle: true,
    write: false,
    outfile: '/tmp/image-preview-drag-harness.js',
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'local-css' },
    nodePaths: [path.dirname(path.dirname(requireFromRoot.resolve('react')))],
    logLevel: 'silent',
    plugins: [{
      name: 'optional-component-baseline',
      setup(build: any) {
        if (componentSource === null) return;
        build.onLoad({ filter: /ZoomableImagePreview\.tsx$/ }, (args: any) => ({
          contents: componentSource, loader: 'tsx', resolveDir: path.dirname(args.path),
        }));
      },
    }],
  });
  const js = result.outputFiles.find((file: any) => file.path.endsWith('.js'))?.text;
  const css = result.outputFiles.find((file: any) => file.path.endsWith('.css'))?.text;
  assert.ok(js, 'esbuild did not emit harness JavaScript');
  assert.ok(css, 'esbuild did not emit the real CSS module');
  return { js, css };
}

function dialog(page: any) {
  return page.locator('[role="dialog"][aria-label="参考图预览"]');
}

async function emptyStagePoint(page: any) {
  const point = await page.evaluate(() => {
    const stage = document.querySelector('[data-image-preview-stage]');
    const image = stage?.querySelector('img[alt="fixture"]');
    if (!stage || !image) return null;
    const s = stage.getBoundingClientRect();
    const i = image.getBoundingClientRect();
    const points = [
      { x: s.left + 8, y: s.top + 8 }, { x: s.right - 8, y: s.top + 8 },
      { x: s.left + 8, y: s.bottom - 8 }, { x: s.right - 8, y: s.bottom - 8 },
    ];
    return points.find(({ x, y }) => (x < i.left || x > i.right || y < i.top || y > i.bottom)
      && document.elementFromPoint(x, y) === stage) || null;
  });
  assert.ok(point, 'could not locate exposed stage background');
  return point;
}

async function checkCursorZoom(page: any, image: any, label: string) {
  const before = await image.boundingBox();
  assert.ok(before);
  const point = { x: Math.round(before.x + before.width * 0.37), y: Math.round(before.y + before.height * 0.41) };
  const pixel = { x: (point.x - before.x) / before.width, y: (point.y - before.y) / before.height };
  let phase = 'wheel in';
  const assertAnchor = async () => {
    const after = await image.boundingBox();
    assert.ok(after);
    assert.ok(Math.abs(after.x + after.width * pixel.x - point.x) < 0.25, `${label} ${phase}: horizontal cursor anchor drifted: ${JSON.stringify({ before, after, point })}`);
    assert.ok(Math.abs(after.y + after.height * pixel.y - point.y) < 0.25, `${label} ${phase}: vertical cursor anchor drifted: ${JSON.stringify({ before, after, point })}`);
  };
  const waitWidth = async (expected: number) => {
    await image.evaluate(async (element: HTMLElement, width: number) => {
      for (let frame = 0; frame < 90; frame++) {
        if (Math.abs(element.getBoundingClientRect().width - width) < 0.5) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error(`Expected width ${width}, got ${element.getBoundingClientRect().width}`);
    }, expected);
  };
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -100);
  await waitWidth(before.width * 1.2);
  await assertAnchor();
  phase = 'wheel out';
  await page.mouse.wheel(0, 100);
  await waitWidth(before.width);
  await assertAnchor();
  phase = 'keyboard';
  await page.keyboard.press('+');
  await waitWidth(before.width * 1.2);
  await assertAnchor();
  phase = 'button';
  await page.getByRole('button', { name: '缩小图片' }).click();
  await waitWidth(before.width);
  await assertAnchor();

  // A single JS turn stresses React's batched native wheel updates without paid/network calls.
  phase = 'batch';
  await page.evaluate(({ x, y }: { x: number; y: number }) => {
    const target = document.elementFromPoint(x, y)!;
    for (let i = 0; i < 3; i++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -100 }));
  }, point);
  await waitWidth(before.width * 1.2 ** 3);
  await assertAnchor();
  for (const [deltaY, expectedScale] of [[-100, 6], [100, 0.5]]) {
    phase = `clamp ${expectedScale}`;
    await page.evaluate(({ x, y, delta }: { x: number; y: number; delta: number }) => {
      const target = document.elementFromPoint(x, y)!;
      for (let i = 0; i < 48; i++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: delta }));
    }, { ...point, delta: deltaY });
    await waitWidth(before.width * expectedScale);
    await assertAnchor();
  }
  await page.getByRole('button', { name: '还原图片大小' }).click();
  log(`PASS ${label}: real-wheel, keyboard/button, batch and zoom limits keep cursor pixel fixed`);
}

async function main() {
  let browser: any;
  let context: any;
  let exitCode = 0;
  try {
    const esbuildPath = requireFromRoot.resolve('esbuild');
    const esbuild = requireFromRoot('esbuild');
    if (!esbuild?.build) throw new Error('resolved esbuild does not export build()');
    const baseline = baselineSource();
    log(`esbuild ${esbuild.version} resolved: ${esbuildPath}`);
    log(`component=${baseline.label}; CSS module=working tree`);
    const { js, css } = await bundle(esbuild, baseline.source);

    const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
    const playwrightPath = requireFromRoot.resolve(playwrightModule);
    const { chromium } = requireFromRoot(playwrightModule);
    if (!chromium?.launch) throw new Error(`PLAYWRIGHT_MODULE=${playwrightModule} has no chromium export`);
    log(`isolated real-component harness bundled; Playwright=${playwrightPath}`);

    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const externalRequests: string[] = [];
    await context.route(/^https?:\/\//, async (route: any) => {
      const request = route.request();
      externalRequests.push(`${request.method()} ${new URL(request.url()).origin}`);
      await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error: Error) => pageErrors.push(error.message));
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%}</style></head><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });

    const preview = dialog(page);
    const image = page.locator('[data-image-preview-stage] img[alt="fixture"]');
    await preview.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForFunction(() => {
      const item = document.querySelector('[data-image-preview-stage] img') as HTMLImageElement | null;
      return Boolean(item?.complete && item.naturalWidth > 0);
    }, null, { timeout: timeoutMs });
    await checkCursorZoom(page, image, 'single image');
    await page.getByRole('button', { name: '放大图片' }).click();
    await page.waitForFunction(() => document.querySelector('[data-image-preview-stage] img[alt="fixture"]')?.getAttribute('style')?.includes('scale(1.2)'), null, { timeout: timeoutMs });
    await image.evaluate(async (element: HTMLElement) => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
    log('PASS real component opened and zoomed');

    const background = await emptyStagePoint(page);
    const before = await image.getAttribute('style');
    const box = await image.boundingBox();
    assert.ok(box, 'preview image is not visible before drag');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(background.x, background.y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await preview.count(), 1, 'dragging from image to background must not close preview');
    await image.evaluate(async (element: HTMLElement) => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
    assert.notEqual(await image.getAttribute('style'), before, 'drag must move the zoomed image');
    log('PASS zoomed real-mouse drag moves image without closing preview');

    const lightPoint = await emptyStagePoint(page);
    await page.mouse.click(lightPoint.x, lightPoint.y);
    await preview.waitFor({ state: 'detached', timeout: timeoutMs });
    log('PASS light background click closes preview');

    await page.getByTestId('open').click();
    await preview.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'detached', timeout: timeoutMs });
    log('PASS Escape closes preview');

    await page.getByTestId('open').click();
    await preview.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByRole('button', { name: '放大图片' }).click();
    await image.click();
    assert.equal(await preview.count(), 1, 'clicking a captured image must not close preview');
    await page.getByRole('button', { name: '关闭预览' }).click();
    await preview.waitFor({ state: 'detached', timeout: timeoutMs });
    log('PASS image click stays open; close button still works');

    for (const vertical of [false, true]) {
      await page.getByTestId('open').click();
      await preview.waitFor({ state: 'visible', timeout: timeoutMs });
      await page.getByRole('button', { name: '对比参考图' }).click();
      if (vertical) await page.getByRole('button', { name: '切换上下对比' }).click();
      await checkCursorZoom(page, page.locator('[data-image-preview-pane="reference"] img'), `${vertical ? 'vertical' : 'horizontal'} reference`);
      await checkCursorZoom(page, page.locator('[data-image-preview-pane="result"] img'), `${vertical ? 'vertical' : 'horizontal'} result`);
      await page.getByRole('button', { name: '放大图片' }).click();
      const reference = page.locator('[data-image-preview-pane="reference"] img');
      await reference.evaluate(async (element: HTMLElement) => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
      const bounds = await reference.boundingBox();
      assert.ok(bounds);
      const transformBefore = await reference.getAttribute('style');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 50, { steps: 5 });
      await page.mouse.up();
      assert.equal(await preview.count(), 1, 'comparison drag must not close preview');
      assert.notEqual(await reference.getAttribute('style'), transformBefore);
      await page.keyboard.press('Escape');
      await preview.waitFor({ state: 'detached', timeout: timeoutMs });
    }
    log('PASS horizontal and vertical comparison real-mouse drags stay open');
    assert.deepEqual(pageErrors, [], 'harness raised a browser error');
    assert.deepEqual(externalRequests, [], 'harness must not make external HTTP requests');
    log('PASS no external HTTP/provider calls');
  } catch (error) {
    exitCode = 1;
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    log(`exit code: ${exitCode}`);
    process.exitCode = exitCode;
  }
}

void main();
