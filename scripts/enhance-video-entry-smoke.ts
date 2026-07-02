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

const client = read('src/components/generate/EnhanceVideoPageClient.tsx');
assertContains(client, '/api/video/list?page=1&limit=', 'enhance page task list');
assertContains(client, 'EnhanceVideoAction', 'enhance page action');
assertContains(client, 'canEnhance', 'enhance page eligibility filter');

const navigation = read('src/lib/navigation.ts');
assertContains(navigation, "href: '/generate/enhance'", 'navigation entry');
assertContains(navigation, "label: '视频超分'", 'side nav label');

const generateClient = read('src/components/generate/GeneratePageClient.tsx');
assertContains(generateClient, "{ href: '/generate/enhance', label: '视频超分' }", 'generate hero link');

const dashboard = read('src/app/dashboard/page.tsx');
assertContains(dashboard, 'href="/generate/enhance"', 'dashboard link');

const assetsPage = read('src/app/assets/page.tsx');
assertContains(assetsPage, 'canEnhanceVideo', 'asset library enhance eligibility');
assertContains(assetsPage, 'asset-card-hover-enhance', 'asset card hover enhance action');
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

console.log('enhance-video-entry smoke passed');
