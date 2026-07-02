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
assertContains(thumbnail, 'task-video-thumbnail-enhance-badge', 'thumbnail enhance badge render');
assertContains(thumbnail, '超分', 'thumbnail enhance badge label');

const globals = read('src/app/globals.css');
assertContains(globals, '.task-video-thumbnail-enhance-badge', 'thumbnail enhance badge style');
assertContains(globals, '.task-video-thumbnail-enhance-badge + .task-video-thumbnail-overlay', 'thumbnail overlay collision guard');

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

const ipListRoute = read('src/app/api/ip/video/list/route.ts');
assertContains(ipListRoute, 'provider: true', 'IP task list provider select');

console.log('enhance-thumbnail-badge smoke passed');
