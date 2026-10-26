import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const timeoutMs = 5000;
const screenshotPath = path.join(os.tmpdir(), 'sd2-image-studio-sidebar-layout.png');

function log(message: string) {
  console.log(`[image-studio-sidebar-layout-smoke] ${message}`);
}

async function compileCssModule(esbuild: any, file: string, globalName: string) {
  const result = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: `import styles from './${file}'; window.${globalName} = styles;`,
      loader: 'js', resolveDir: root, sourcefile: `${globalName}.js`,
    },
    bundle: true, write: false, outfile: path.join(os.tmpdir(), `${globalName}.js`),
    platform: 'browser', format: 'iife', target: ['chrome120'],
    loader: { '.css': 'local-css' }, logLevel: 'silent',
  });
  const js = result.outputFiles.find((item: any) => item.path.endsWith('.js'))?.text;
  const css = result.outputFiles.find((item: any) => item.path.endsWith('.css'))?.text;
  assert.ok(js && css, `esbuild did not emit JS and isolated CSS for ${file}`);
  return { js, css };
}

async function main() {
  let browser: any;
  let context: any;
  let exitCode = 0;
  try {
    const esbuild = requireFromRoot('esbuild');
    assert.ok(esbuild?.build, 'esbuild does not export build()');
    const image = await compileCssModule(esbuild, 'src/app/image-studio/studio.module.css', '__imageStyles');
    const shell = await compileCssModule(esbuild, 'src/components/template-studio/template-studio.module.css', '__shellStyles');
    const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
    const playwrightPath = requireFromRoot.resolve(playwrightModule);
    const { chromium } = requireFromRoot(playwrightModule);
    assert.ok(chromium?.launch, `PLAYWRIGHT_MODULE=${playwrightModule} did not export chromium`);
    log(`isolated CSS modules compiled; Playwright=${playwrightPath}`);

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext({ viewport: { width: 1617, height: 873 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--composer-topbar-height:48px}html,body{margin:0;min-height:100%;font:14px system-ui;background:#101315}*,*::before,*::after{box-sizing:border-box}</style></head><body></body></html>');
    await page.addStyleTag({ content: image.css });
    await page.addStyleTag({ content: shell.css });
    await page.addScriptTag({ content: image.js });
    await page.addScriptTag({ content: shell.js });

    const classes = await page.evaluate('({ image: window.__imageStyles, shell: window.__shellStyles })');
    const groups = Array.from({ length: 24 }, (_, index) => `<div class="${classes.image.moduleRailGroup}"><button type="button"><span>分组 ${index + 1}</span><small>2</small></button><div class="${classes.image.moduleRailChildren}"><button class="${classes.image.moduleRailChild}">模块 A-${index + 1}</button><button class="${classes.image.moduleRailChild}">模块 B-${index + 1}</button></div></div>`).join('');
    const markup = `<section class="${classes.shell.workbench}"><header data-testid="shell-header" class="${classes.shell.header} ${classes.shell.imageHeader}"><div data-testid="shell-title" class="${classes.shell.headerTitle}"><span class="${classes.shell.kicker}">创作</span><h1>模板工作台</h1></div><nav data-testid="category-tabs" class="${classes.shell.categoryTabs}"><button type="button">图片</button><button type="button">视频</button></nav></header><div class="${classes.shell.imageSurface}"><main class="${classes.image.page}"><aside data-testid="rail" class="${classes.image.moduleRail}" aria-label="分组快捷栏"><div class="${classes.image.moduleRailTitle}">分组快捷栏</div>${groups}<button data-testid="rail-last" type="button">全部封面<small>24</small></button></aside><section class="${classes.image.module}"><header class="${classes.image.header}"><h2>模块标题</h2></header><div style="height:1800px">合成长页面内容</div></section></main></div></section>`;
    await page.evaluate(`document.body.innerHTML = '<header style="height:48px;position:sticky;top:0;z-index:60;background:#111d2a;color:#e6e8eb;padding:12px 20px">SD2 layout fixture</header>' + ${JSON.stringify(markup)}`);
    await page.waitForFunction((selector: string) => Boolean(document.querySelector(selector)?.getBoundingClientRect().height), '[data-testid="rail"]', { timeout: timeoutMs });

    const rail = page.locator('[data-testid="rail"]');
    const title = page.locator('[data-testid="shell-title"]');
    const tabs = page.locator('[data-testid="category-tabs"]');
    const railBox = await rail.boundingBox();
    const titleBox = await title.boundingBox();
    const tabsBox = await tabs.boundingBox();
    assert.ok(railBox && titleBox && tabsBox, 'desktop fixture regions must be visible');
    assert.ok(Math.abs(railBox.y - 48) <= 0.5, `desktop rail top is ${railBox.y}px, expected 48px`);
    assert.ok(Math.abs(railBox.height - (873 - 48)) <= 0.5, `desktop rail height is ${railBox.height}px`);
    assert.ok(titleBox.x >= railBox.x + railBox.width - 0.5, 'desktop title overlaps the fixed rail');
    assert.ok(titleBox.x + titleBox.width <= tabsBox.x + 0.5, 'desktop title overlaps category tabs');
    assert.equal(await rail.evaluate((element: HTMLElement) => getComputedStyle(element).scrollbarWidth), 'thin', 'desktop rail scrollbar must remain thin, not hidden');
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });

    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
    await page.mouse.wheel(0, 700);
    await page.waitForFunction((selector: string) => ((document.querySelector(selector) as HTMLElement | null)?.scrollTop ?? 0) >= 700, '[data-testid="rail"]', { timeout: timeoutMs });
    let positions = await page.evaluate('({ rail: document.querySelector("[data-testid=rail]").scrollTop, page: window.scrollY })');
    assert.ok(positions.rail > 0, 'wheel over rail must scroll the rail');
    assert.equal(positions.page, 0, 'wheel over rail must not scroll the page');

    const railBeforePage = positions.rail;
    await page.mouse.move(900, 600);
    await page.mouse.wheel(0, 700);
    await page.waitForFunction((previous: number) => window.scrollY > previous, positions.page, { timeout: timeoutMs });
    const pageScroll = await page.evaluate('window.scrollY');
    positions = await page.evaluate('({ rail: document.querySelector("[data-testid=rail]").scrollTop, page: window.scrollY })');
    assert.ok(pageScroll > 0, 'wheel on page content must scroll the page');
    assert.equal(positions.rail, railBeforePage, 'page scrolling must not move the rail');

    const pageBeforeRailEnd = positions.page;
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
    await page.mouse.wheel(0, 6000);
    await page.waitForFunction((selector: string) => {
      const railElement = document.querySelector(selector);
      const last = railElement?.querySelector('[data-testid="rail-last"]');
      if (!railElement || !last) return false;
      const railRect = railElement.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return lastRect.bottom <= railRect.bottom && lastRect.top >= railRect.top;
    }, '[data-testid="rail"]', { timeout: timeoutMs });
    assert.equal(await page.evaluate('window.scrollY'), pageBeforeRailEnd, 'scrolling rail to its last button must not move the page');
    log('PASS desktop rail and page scroll independently; last rail button is reachable');

    await page.setViewportSize({ width: 1294, height: 698 });
    await page.evaluate('window.scrollTo(0, 0)');
    const compactRail = await rail.boundingBox();
    const compactTitle = await title.boundingBox();
    assert.ok(compactRail && compactTitle && compactTitle.x >= compactRail.x + compactRail.width, 'compact desktop title must not overlap rail');
    assert.ok(Math.abs(compactRail.height - 650) <= 0.5, 'compact desktop rail must fit available height');
    log('PASS compact desktop 1294x698');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate('window.scrollTo(0, 0); document.querySelector("[data-testid=rail]").scrollTop = 0');
    const mobile = await page.evaluate(`(() => {
      const rect = (selector) => { const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; };
      const rail = document.querySelector('[data-testid="rail"]');
      const style = getComputedStyle(rail);
      return { header: rect('[data-testid="shell-header"]'), title: rect('[data-testid="shell-title"]'), tabs: rect('[data-testid="category-tabs"]'), rail: rect('[data-testid="rail"]'), display: style.display, position: style.position, overflowX: style.overflowX, railTitleDisplay: getComputedStyle(rail.firstElementChild).display, scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth };
    })()`);
    assert.equal(mobile.header.width, 390, 'mobile shell header must use the viewport width');
    assert.ok(mobile.title.left < 80, `mobile title is shifted right (${mobile.title.left}px), possibly by desktop rail spacing`);
    assert.ok(mobile.tabs.right <= 390.5, 'mobile category tabs overflow the viewport');
    assert.equal(mobile.display, 'flex', 'mobile rail must retain horizontal navigation layout');
    assert.equal(mobile.position, 'sticky', 'mobile rail must retain sticky horizontal navigation');
    assert.equal(mobile.overflowX, 'auto', 'mobile rail must remain horizontally scrollable');
    assert.equal(mobile.railTitleDisplay, 'none', 'mobile rail must hide its desktop title');
    assert.ok(mobile.scrollWidth > mobile.clientWidth, 'mobile rail fixture must expose horizontal scrolling');
    log('PASS mobile header is not shifted by desktop rail spacing; horizontal rail remains scrollable');
    log(`synthetic screenshot: ${screenshotPath}`);
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
