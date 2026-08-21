import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import assert from 'assert';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function listRouteFiles(dir = path.join(root, 'src/app/api')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listRouteFiles(fullPath);
    return entry.isFile() && entry.name === 'route.ts'
      ? [path.relative(root, fullPath)]
      : [];
  });
}

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\/\u0000\//g, '(?:/.*/|/)')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const routeMatrix = [
  ['admin_only', 'src/app/api/admin/**/route.ts'],
  ['admin_only', 'src/app/api/admin/**/route.tsx'],

  ['public_signed_or_minimal', 'src/app/api/auth/**/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/provider/seedance/callback/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/health/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/config/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/codex/**/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/feishu/**/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/feedback/route.ts'],
  ['public_signed_or_minimal', 'src/app/api/feedback/upload/route.ts'],

  ['external_allowed', 'src/app/api/ip/**/route.ts'],
  ['external_allowed', 'src/app/api/me/**/route.ts'],
  ['external_allowed', 'src/app/api/notifications/**/route.ts'],
  ['external_allowed', 'src/app/api/assets/library/route.ts'],
  ['external_allowed', 'src/app/api/assets/library/**/route.ts'],
  ['external_allowed', 'src/app/api/assets/upload/route.ts'],
  ['external_allowed', 'src/app/api/assets/upload-ticket/route.ts'],
  ['external_allowed', 'src/app/api/assets/upload-proxy/route.ts'],
  ['external_allowed', 'src/app/api/assets/upload-complete/route.ts'],
  ['external_allowed', 'src/app/api/assets/upload-and-create/route.ts'],
  ['external_allowed', 'src/app/api/assets/multipart/**/route.ts'],
  ['external_allowed', 'src/app/api/workspace/**/route.ts'],
  ['external_allowed', 'src/app/api/reference-albums/route.ts'],
  ['external_allowed', 'src/app/api/reference-albums/[id]/route.ts'],
  ['external_allowed', 'src/app/api/reference-albums/[id]/images/route.ts'],
  ['external_allowed', 'src/app/api/reference-albums/[id]/shares/route.ts'],
  ['external_allowed', 'src/app/api/reference-images/[id]/route.ts'],
  ['external_allowed', 'src/app/api/reference-images/[id]/share-album/route.ts'],
  ['external_allowed', 'src/app/api/reference-images/[id]/content/route.ts'],
  ['external_allowed', 'src/app/api/collections/route.ts'],
  ['external_allowed', 'src/app/api/collections/[id]/route.ts'],
  ['external_allowed', 'src/app/api/collections/[id]/load/route.ts'],
  ['external_scoped_dependency', 'src/app/api/projects/route.ts'],
  ['external_scoped_dependency', 'src/app/api/projects/[id]/route.ts'],
  ['external_scoped_dependency', 'src/app/api/projects/[id]/video-cards/route.ts'],

  ['internal_only', 'src/app/api/tasks/create/route.ts'],
  ['internal_only', 'src/app/api/tasks/enhance-video/create/route.ts'],
  ['internal_only', 'src/app/api/tasks/estimate/route.ts'],
  ['internal_only', 'src/app/api/tasks/[id]/reuse/route.ts'],
  ['internal_only', 'src/app/api/video/create/route.ts'],
  ['internal_only', 'src/app/api/video/retry/[id]/route.ts'],
  ['internal_only', 'src/app/api/video/list/route.ts'],
  ['internal_only', 'src/app/api/video/status/[id]/route.ts'],
  ['internal_only', 'src/app/api/video/play/[id]/route.ts'],
  ['internal_only', 'src/app/api/assets/list/route.ts'],
  ['internal_only', 'src/app/api/assets/create-from-url/route.ts'],
  ['internal_only', 'src/app/api/assets/[id]/route.ts'],
  ['internal_only', 'src/app/api/assets/[id]/provider-delete/route.ts'],
  ['internal_only', 'src/app/api/assets/generate/route.ts'],
  ['internal_only', 'src/app/api/templates/**/route.ts'],
  ['internal_only', 'src/app/api/tools/ultimate-canvas/**/route.ts'],
  ['internal_only', 'src/app/api/projects/[id]/budget/route.ts'],
  ['internal_only', 'src/app/api/projects/[id]/costs/export/route.ts'],
  ['internal_only', 'src/app/api/projects/[id]/review-card/route.ts'],
  ['internal_only', 'src/app/api/projects/[id]/members/**/route.ts'],
  ['internal_only', 'src/app/api/projects/[id]/invites/route.ts'],
  ['internal_only', 'src/app/api/project-invites/**/route.ts'],
  ['internal_only', 'src/app/api/album-shares/**/route.ts'],
  ['internal_only', 'src/app/api/reference-albums/[id]/shares/**/route.ts'],
  ['internal_only', 'src/app/api/reference-albums/[id]/public-submissions/route.ts'],
  ['internal_only', 'src/app/api/reference-album-folders/**/route.ts'],
  ['internal_only', 'src/app/api/approvals/**/route.ts'],
  ['internal_only', 'src/app/api/review-cards/route.ts'],
  ['internal_only', 'src/app/api/cutout/[[...path]]/route.ts'],
  ['internal_only', 'src/app/api/video-cards/**/route.ts'],
  ['internal_only', 'src/app/api/tasks/[id]/project/route.ts'],
  ['internal_only', 'src/app/api/tasks/[id]/route.ts'],
  ['internal_only', 'src/app/api/video/bulk-download/route.ts'],
  ['internal_only', 'src/app/api/video/download/[id]/route.ts'],
  ['internal_only', 'src/app/api/video/thumbnail/[id]/route.ts'],
  ['internal_only', 'src/app/api/assets/history/**/route.ts'],
  ['internal_only', 'src/app/api/agent/**/route.ts'],
] as const;

function classify(route: string) {
  return routeMatrix.find(([, pattern]) => globToRegExp(pattern).test(route))?.[0] ?? null;
}

const routeFiles = listRouteFiles().sort();
const unclassified = routeFiles.filter((route) => !classify(route));
assert.deepStrictEqual(unclassified, [], `未分类 API 路由：\n${unclassified.join('\n')}`);

const guardPath = 'src/lib/access/feature-guard.ts';
assert.ok(existsSync(path.join(root, guardPath)), '缺少统一外部权限守门 helper');
const guard = read(guardPath);
for (const allowed of ['ip_generate', 'asset_library', 'reference_album', 'task_view']) {
  assert.match(guard, new RegExp(`['"]${allowed}['"]`), `外部白名单缺少 ${allowed}`);
}
for (const blocked of ['standard_generate', 'template_view', 'template_generate', 'ultimate_canvas', 'legacy_seedance_assets', 'team_project_manage', 'asset_image_generate', 'video_enhance', 'task_retry']) {
  assert.match(guard, new RegExp(`['"]${blocked}['"]`), `feature key 缺少 ${blocked}`);
}

const mustUseInternalOnly = [
  'src/app/api/assets/list/route.ts',
  'src/app/api/assets/create-from-url/route.ts',
  'src/app/api/assets/[id]/route.ts',
  'src/app/api/assets/[id]/provider-delete/route.ts',
  'src/app/api/assets/generate/route.ts',
  'src/app/api/tasks/enhance-video/create/route.ts',
  'src/app/api/tasks/estimate/route.ts',
  'src/app/api/tasks/[id]/route.ts',
  'src/app/api/tasks/[id]/reuse/route.ts',
  'src/app/api/video/retry/[id]/route.ts',
  'src/app/api/video/status/[id]/route.ts',
  'src/app/api/templates/route.ts',
  'src/app/api/templates/[id]/route.ts',
  'src/app/api/tools/ultimate-canvas/bootstrap/route.ts',
  'src/app/api/tools/ultimate-canvas/document/route.ts',
  'src/app/api/tools/ultimate-canvas/generate/route.ts',
  'src/app/api/tools/ultimate-canvas/upload/route.ts',
  'src/app/api/tools/ultimate-canvas/localization-health/route.ts',
];
for (const route of mustUseInternalOnly) {
  assert.match(read(route), /assertInternalOnly|assertFeatureAllowed/, `${route} 缺少外部权限守门`);
}

assert.match(read('src/app/api/tasks/create/route.ts'), /assertFeatureAllowed\(user,\s*['"]standard_generate['"]/, '普通生成接口必须显式禁止外部用户');
assert.match(read('src/app/api/video/play/[id]/route.ts'), /getSession|getSessionUser/, '视频播放接口必须要求登录');
assert.match(read('src/app/api/video/play/[id]/route.ts'), /assertCanViewTask/, '视频播放接口必须校验任务归属');

const navigation = read('src/lib/navigation.ts');
assert.match(navigation, /externalOnlyHidden|externalAllowed/, '导航配置必须能表达外部专属隐藏/允许');
assert.match(navigation, /我的项目[\s\S]*externalHidden/, '外部侧边栏不能显示我的项目');
assert.match(navigation, /IP生成[\s\S]*externalHidden/, '外部侧边栏不能显示 IP 生成，IP 入口只保留在顶部');

const generatePage = read('src/app/generate/page.tsx');
assert.match(generatePage, /isExternalUser/, '普通生成页面必须服务端拦截外部用户');
assert.match(read('src/app/generate/enhance/page.tsx'), /isExternalUser|assertInternalOnly/, '增强页面必须服务端拦截外部用户');
assert.match(
  read('src/app/projects/page.tsx'),
  /isExternalUser[\s\S]*externalFallbackPath|externalFallbackPath[\s\S]*isExternalUser/,
  '我的项目页面必须把外部用户回退到 IP 生成',
);

console.log('external-access-matrix-smoke passed');
