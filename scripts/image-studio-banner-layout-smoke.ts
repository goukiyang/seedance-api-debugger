import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const timeoutMs = 5000;
const screenshotPath = path.join(os.tmpdir(), 'sd2-image-studio-banner-layout.png');
const fixtures = [
  { name: 'landscape', width: 1600, height: 900 },
  { name: 'portrait', width: 900, height: 1600 },
  { name: 'square', width: 1000, height: 1000 },
].map(fixture => ({
  ...fixture,
  src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${fixture.width}" height="${fixture.height}"><rect width="100%" height="100%" fill="#345"/><circle cx="50%" cy="50%" r="22%" fill="#e7b75d"/></svg>`)}`,
}));
const viewports = [
  { name: 'desktop-1617x873', width: 1617, height: 873, maxImageHeight: 180, maxBannerHeight: 182 },
  { name: 'wide-2560x1440', width: 2560, height: 1440, maxImageHeight: 180, maxBannerHeight: 182 },
  { name: 'mobile-390x844', width: 390, height: 844, maxImageHeight: 120, maxBannerHeight: 122 },
];

function log(message: string) {
  console.log(`[image-studio-banner-layout-smoke] ${message}`);
}

async function main() {
  let browser: any;
  let context: any;
  let exitCode = 0;
  try {
    const css = await readFile(path.join(root, 'src/app/image-studio/studio.module.css'), 'utf8');
    const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
    const playwrightPath = requireFromRoot.resolve(playwrightModule);
    const { chromium } = requireFromRoot(playwrightModule);
    if (!chromium?.launch) throw new Error(`PLAYWRIGHT_MODULE=${playwrightModule} did not export chromium`);
    log(`loaded real studio.module.css; Playwright=${playwrightPath}`);

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext({ viewport: { width: 1617, height: 873 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;}*,*::before,*::after{box-sizing:border-box;}</style></head><body><main class="page"><section class="module"><header class="header"><h2>Banner fixture</h2></header><div class="moduleBanner moduleBannerHasImage"><img class="moduleBannerImage" alt="Synthetic banner fixture"><span class="bannerLabel">Fixture</span><button class="bannerReplace" type="button">Replace</button><button class="bannerRemove" type="button" aria-label="Remove fixture">×</button></div><div class="workspace"><section class="inputs">Fixture workspace</section><section class="outputs">Fixture results</section></div></section></main></body></html>`);
    await page.addStyleTag({ content: css });

    const image = page.locator('.moduleBannerImage');
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const fixture of fixtures) {
        await image.evaluate((element: HTMLImageElement, src: string) => { element.src = src; }, fixture.src);
        await page.waitForFunction(({ src, width, height }: { src: string; width: number; height: number }) => {
          const element = document.querySelector('.moduleBannerImage') as HTMLImageElement | null;
          return Boolean(element && element.src === src && element.complete && element.naturalWidth === width && element.naturalHeight === height);
        }, fixture, { timeout: timeoutMs });

        const layout = await page.evaluate(`(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
          };
          const banner = rect('.moduleBanner');
          const imageRect = rect('.moduleBannerImage');
          const remove = rect('.bannerRemove');
          const replace = rect('.bannerReplace');
          const workspace = rect('.workspace');
          const imageElement = document.querySelector('.moduleBannerImage');
          return {
            banner, image: imageRect, remove, replace, workspace,
            objectFit: imageElement ? getComputedStyle(imageElement).objectFit : '',
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
          };
        })()`);

        assert.ok(layout.banner && layout.image && layout.remove && layout.replace && layout.workspace, 'fixture elements must exist');
        assert.ok(layout.image.height <= viewport.maxImageHeight + 0.5, `${viewport.name}/${fixture.name}: image height ${layout.image.height} exceeds ${viewport.maxImageHeight}px`);
        assert.ok(layout.banner.height <= viewport.maxBannerHeight + 0.5, `${viewport.name}/${fixture.name}: banner container is too tall (${layout.banner.height}px)`);
        assert.equal(layout.objectFit, 'contain', `${viewport.name}/${fixture.name}: banner image must use contain`);
        assert.ok(layout.remove.left >= layout.banner.left - 0.5 && layout.remove.top >= layout.banner.top - 0.5
          && layout.remove.right <= layout.banner.right + 0.5 && layout.remove.bottom <= layout.banner.bottom + 0.5,
        `${viewport.name}/${fixture.name}: remove button must stay inside banner`);
        assert.ok(layout.replace.left >= layout.banner.left && layout.replace.top >= layout.banner.top
          && layout.replace.right <= layout.remove.left && layout.replace.bottom <= layout.banner.bottom,
        `${viewport.name}/${fixture.name}: replace button must stay inside banner without overlapping remove`);
        assert.ok(layout.documentWidth <= viewport.width && layout.bodyWidth <= viewport.width,
          `${viewport.name}/${fixture.name}: horizontal overflow (${layout.documentWidth}/${layout.bodyWidth}px)`);
        const workspaceGap = layout.workspace.top - layout.banner.bottom;
        assert.ok(workspaceGap >= 23 && workspaceGap <= 25, `${viewport.name}/${fixture.name}: workspace gap is ${workspaceGap}px`);
        assert.ok(layout.workspace.top - layout.banner.top <= viewport.maxImageHeight + 27,
          `${viewport.name}/${fixture.name}: banner pushed the workspace down`);

        log(`PASS ${viewport.name}/${fixture.name}: image=${layout.image.height.toFixed(1)}px workspace-gap=${workspaceGap.toFixed(1)}px`);
        if (viewport.name === 'desktop-1617x873' && fixture.name === 'landscape') {
          await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
          log(`fixture screenshot: ${screenshotPath}`);
        }
      }
    }
    log('all banner layout checks passed');
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
