import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath: string) {
  return readFileSync(relativePath, 'utf8');
}

function assertContains(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}

function assertNotContains(source: string, needle: string, label: string) {
  assert.ok(!source.includes(needle), `${label}: unexpected ${needle}`);
}

const page = read('src/app/tools/ultimate-canvas/page.tsx');
assertContains(page, "redirect('/login?next=/tools/ultimate-canvas')", 'page keeps login protection');
assertNotContains(page, "user.role !== 'admin'", 'page does not redirect normal users');

const index = read('public/tools/ultimate-canvas/index.html');
assertContains(index, "fetch('/api/auth/me'", 'static page checks login');
assertContains(index, "data-auth-check=\"pending\"", 'static page hides while checking login');
assertNotContains(index, "user.role !== 'admin'", 'static page does not redirect normal users');
assertNotContains(index, "window.location.replace('/generate')", 'static page does not send normal users away');

const navigation = read('src/lib/navigation.ts');
assertContains(
  navigation,
  "{ label: '无线画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'], prefixMatch: true }",
  'topbar ultimate canvas visible to normal users',
);
assertContains(
  navigation,
  "{ label: '无线画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'] }",
  'side nav ultimate canvas visible to normal users',
);

[
  'src/app/api/tools/ultimate-canvas/bootstrap/route.ts',
  'src/app/api/tools/ultimate-canvas/document/route.ts',
  'src/app/api/tools/ultimate-canvas/generate/route.ts',
  'src/app/api/tools/ultimate-canvas/upload/route.ts',
].forEach((relativePath) => {
  const source = read(relativePath);
  assertContains(source, 'getSession()', `${relativePath} keeps login check`);
  assertNotContains(source, '无线画布暂时只对管理员开放', `${relativePath} no blanket admin-only message`);
});

const bootstrapRoute = read('src/app/api/tools/ultimate-canvas/bootstrap/route.ts');
assertContains(bootstrapRoute, "owner_user_id: user.id", 'bootstrap filters normal user owned projects');
assertContains(bootstrapRoute, "members: { some: { user_id: user.id, status: 'active', role: { not: 'viewer' } } }", 'bootstrap filters normal user generatable member projects');
assertNotContains(bootstrapRoute, 'api_key', 'bootstrap does not expose API key fields');
assertNotContains(bootstrapRoute, 'base_url', 'bootstrap does not expose provider base URL fields');

const generateRoute = read('src/app/api/tools/ultimate-canvas/generate/route.ts');
assertContains(generateRoute, "user.role !== 'admin' && !requestedVideoCardId", 'normal LLM generation requires video card context');
assertContains(generateRoute, 'assertCanGenerateInVideoCard(user, project.id, videoCard.id)', 'LLM generation uses video card permission');
assertContains(generateRoute, 'assertCanUseCanvasDocument(user, canvasDocumentId, projectId)', 'LLM generation checks canvas document ownership');
assertContains(generateRoute, "const contextRules = user.role === 'admin' ? rawContextRules : ''", 'normal users cannot apply admin context rules');

const uploadRoute = read('src/app/api/tools/ultimate-canvas/upload/route.ts');
assertContains(uploadRoute, 'assertCanGenerateInVideoCard(user, project.id, videoCard.id)', 'upload uses video card permission');
assertContains(uploadRoute, "if (!videoCardId)", 'upload requires video card');
assertNotContains(uploadRoute, '无线画布暂时只对管理员开放', 'upload has no blanket admin-only message');

const localizationHealthRoute = read('src/app/api/tools/ultimate-canvas/localization-health/route.ts');
assertContains(localizationHealthRoute, "user.role !== 'admin'", 'localization health remains admin-only');
assertContains(localizationHealthRoute, '无线画布本地化健康检查只对管理员开放', 'localization health has scoped admin-only message');

console.log('ultimate-canvas-normal-user-access-smoke passed');
