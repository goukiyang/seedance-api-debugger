import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function assertContains(content: string, needle: string, label: string) {
  if (!content.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

const route = read('src/app/generate/enhance/page.tsx');
assertContains(route, 'EnhanceVideoPageClient', 'enhance route');
assertContains(route, "user.role !== 'admin'", 'enhance route admin gate');

const client = read('src/components/generate/EnhanceVideoPageClient.tsx');
assertContains(client, '/api/video/list?page=1&limit=', 'enhance page task list');
assertContains(client, 'EnhanceVideoAction', 'enhance page action');
assertContains(client, 'canEnhance', 'enhance page eligibility filter');

const navigation = read('src/lib/navigation.ts');
assertContains(navigation, "label: '资产', href: '/assets'", 'topbar asset entry');
assertContains(navigation, "label: '超分', href: '/generate/enhance', match: ['/generate/enhance'], prefixMatch: true, adminOnly: true", 'topbar enhance admin-only entry');
assertContains(navigation, "label: '视频超分', href: '/generate/enhance', match: ['/generate/enhance'], prefixMatch: true, adminOnly: true", 'side nav enhance admin-only label');
assertContains(navigation, "label: '无线画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'], prefixMatch: true, adminOnly: true", 'topbar ultimate canvas admin-only entry');
assertContains(navigation, "label: '工具', href: '/cutout', match: ['/cutout'], prefixMatch: true, adminOnly: true", 'topbar tools admin-only entry');
assertContains(navigation, 'isNavItemVisible', 'shared navigation visibility helper');

const sideNav = read('src/components/SideNav.tsx');
assertContains(sideNav, 'isNavItemVisible(item, isAdmin)', 'side nav admin-only filter');

const generateClient = read('src/components/generate/GeneratePageClient.tsx');
assertContains(generateClient, "{ href: '/generate/enhance', label: '视频超分', adminOnly: true }", 'generate hero admin-only link');
assertContains(generateClient, "link.adminOnly || currentUser?.role === 'admin'", 'generate hero admin-only filter');

const dashboard = read('src/app/dashboard/page.tsx');
assertContains(dashboard, 'href="/generate/enhance"', 'dashboard link');

const assetsPage = read('src/app/assets/page.tsx');
assertContains(assetsPage, 'canEnhanceVideo', 'asset library enhance eligibility');
assertContains(assetsPage, 'asset-card-enhance-trigger', 'asset card right-aligned enhance action');
assertContains(assetsPage, 'isAdmin && item.canEnhanceVideo', 'asset card admin-only enhance action');
assertContains(assetsPage, '/api/tasks/enhance-video/create', 'asset card enhance create action');
assertContains(assetsPage, 'asset-card-badge asset-card-badge-enhance', 'asset card enhance badge');

const assetLibraryRoute = read('src/app/api/assets/library/route.ts');
assertContains(assetLibraryRoute, 'isEnhanceTask', 'asset library enhance badge field');
assertContains(assetLibraryRoute, 'canEnhanceVideo', 'asset library enhance action field');
assertContains(assetLibraryRoute, 'enhanceSourceTaskId', 'asset library enhance source field');

const taskDetail = read('src/app/tasks/[id]/page.tsx');
assertContains(taskDetail, 'task-result-compare-stage', 'task detail enhance compare stage');
assertContains(taskDetail, '原视频', 'task detail source video label');
assertContains(taskDetail, '超分视频', 'task detail enhanced video label');
assertContains(taskDetail, 'handleComparePlay', 'task detail synchronized compare playback');
assertContains(taskDetail, 'isAdmin && <EnhanceVideoAction task={task} />', 'task detail admin-only enhance action');

const enhanceCreateRoute = read('src/app/api/tasks/enhance-video/create/route.ts');
assertContains(enhanceCreateRoute, '视频超分功能暂时只对管理员开放', 'enhance create admin-only gate');

const ultimateCanvasPage = read('src/app/tools/ultimate-canvas/page.tsx');
assertContains(ultimateCanvasPage, "user.role !== 'admin'", 'ultimate canvas page admin gate');

const ultimateCanvasStaticPage = read('public/tools/ultimate-canvas/index.html');
assertContains(ultimateCanvasStaticPage, "data-admin-check=\"pending\"", 'ultimate canvas static page hidden while checking role');
assertContains(ultimateCanvasStaticPage, "user.role !== 'admin'", 'ultimate canvas static page admin gate');

[
  'src/app/api/tools/ultimate-canvas/bootstrap/route.ts',
  'src/app/api/tools/ultimate-canvas/document/route.ts',
  'src/app/api/tools/ultimate-canvas/generate/route.ts',
  'src/app/api/tools/ultimate-canvas/localization-health/route.ts',
  'src/app/api/tools/ultimate-canvas/upload/route.ts',
].forEach((relativePath) => {
  assertContains(read(relativePath), '无线画布暂时只对管理员开放', `${relativePath} admin-only gate`);
});

const cutoutPage = read('src/app/cutout/page.tsx');
assertContains(cutoutPage, "user?.role === 'admin'", 'cutout page admin gate');

const cutoutRoute = read('src/app/api/cutout/[[...path]]/route.ts');
assertContains(cutoutRoute, 'AI 抠图工具暂时只对管理员开放', 'cutout proxy admin-only gate');

console.log('enhance-video-entry smoke passed');
