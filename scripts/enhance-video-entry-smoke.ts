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

console.log('enhance-video-entry smoke passed');
