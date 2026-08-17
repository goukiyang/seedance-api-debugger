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

function assertNotContains(content: string, needle: string, label: string) {
  if (content.includes(needle)) {
    throw new Error(`${label} should not contain: ${needle}`);
  }
}

function assertEveryThumbnailHasEnhanceSignal(relativePath: string) {
  const content = read(relativePath);
  const blocks = content.match(/<TaskVideoThumbnail[\s\S]*?\/>/g) || [];
  if (blocks.length === 0) {
    throw new Error(`${relativePath} has no TaskVideoThumbnail usage`);
  }

  blocks.forEach((block, index) => {
    const hasSignal = block.includes('isEnhanceTask=')
      || (block.includes('provider=') && block.includes('generationMode='));
    if (!hasSignal) {
      throw new Error(`${relativePath} TaskVideoThumbnail #${index + 1} missing enhance badge signal`);
    }
  });
}

const thumbnail = read('src/components/TaskVideoThumbnail.tsx');
assertContains(thumbnail, 'provider?: string | null;', 'thumbnail provider prop');
assertContains(thumbnail, 'generationMode?: string | null;', 'thumbnail generation mode prop');
assertContains(thumbnail, 'isEnhanceTask?: boolean;', 'thumbnail explicit enhance prop');
assertContains(thumbnail, "generationMode === 'enhance_video' || provider === 'volcengine_mediakit'", 'thumbnail enhance rule');
assertContains(thumbnail, 'is-enhance-task', 'thumbnail enhance state class');
assertContains(thumbnail, 'task-video-thumbnail-enhance-badge', 'thumbnail enhance badge render');
assertContains(thumbnail, '超分', 'thumbnail enhance badge label');

const globals = read('src/app/globals.css');
assertContains(globals, '.task-video-thumbnail-enhance-badge', 'thumbnail enhance badge style');
assertContains(globals, 'inset: 6px 6px auto auto;', 'thumbnail enhance badge must sit at top right');
assertContains(globals, '.task-enhance-chip', 'task info enhance chip style');
assertContains(globals, '.composer-task-card-enhance-chip', 'generate recent task enhance chip style');
assertContains(globals, '.composer-task-card-preview > .task-video-thumbnail-placeholder', 'generate recent task placeholder style must be scoped');
assertNotContains(globals, '.composer-task-card-preview > span', 'generate recent task preview must not style every span');

[
  'src/app/tasks/page.tsx',
  'src/app/admin/outputs/AdminOutputsClient.tsx',
  'src/components/generate/GeneratePageClient.tsx',
  'src/components/generate/EnhanceVideoPageClient.tsx',
  'src/app/projects/[id]/video-cards/[cardId]/page.tsx',
  'src/app/projects/[id]/page.tsx',
  'src/app/admin/costs/page.tsx',
  'src/app/admin/AdminGenerationDashboardClient.tsx',
].forEach(assertEveryThumbnailHasEnhanceSignal);

const projectRoute = read('src/app/api/projects/[id]/route.ts');
assertContains(projectRoute, 'provider: true', 'project route provider select');
assertContains(projectRoute, 'generation_mode: true', 'project route generation mode select');
assertContains(projectRoute, 'provider: task.provider', 'project route preview provider serialization');
assertContains(projectRoute, 'generation_mode: task.generation_mode', 'project route preview generation mode serialization');

const dashboardLib = read('src/lib/admin/generation-dashboard.ts');
assertContains(dashboardLib, 'provider: string;', 'dashboard recent task provider type');
assertContains(dashboardLib, 'generation_mode: string;', 'dashboard recent task generation mode type');
assertContains(dashboardLib, 'provider: task.provider', 'dashboard recent task provider dto');
assertContains(dashboardLib, 'generation_mode: task.generation_mode', 'dashboard recent task generation mode dto');

const projectPage = read('src/app/projects/[id]/page.tsx');
assertContains(projectPage, 'isEnhanceTask(previewTask)', 'project video card preview enhance badge');
assertContains(projectPage, 'task-enhance-chip', 'project recent tasks must show enhance chip outside thumbnail');

const tasksPage = read('src/app/tasks/page.tsx');
assertContains(tasksPage, 'isEnhanceTask(task)', 'tasks page must classify enhance tasks');
assertContains(tasksPage, 'task-enhance-chip', 'tasks page must show enhance chip outside thumbnail');

const generatePage = read('src/components/generate/GeneratePageClient.tsx');
assertContains(generatePage, 'isRecentEnhanceTask(task)', 'generate recent tasks must classify enhance tasks');
assertContains(generatePage, 'composer-task-card-enhance-chip', 'generate recent tasks must show enhance chip outside thumbnail');

const adminDashboard = read('src/app/admin/AdminGenerationDashboardClient.tsx');
assertContains(adminDashboard, 'isDashboardEnhanceTask(task)', 'admin recent tasks must classify enhance tasks');
assertContains(adminDashboard, 'task-enhance-chip', 'admin recent tasks must show enhance chip outside thumbnail');

const ipListRoute = read('src/app/api/ip/video/list/route.ts');
assertContains(ipListRoute, 'provider: true', 'IP task list provider select');

console.log('enhance-thumbnail-badge smoke passed');
