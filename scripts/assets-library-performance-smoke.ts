import { readFileSync } from 'fs';
import path from 'path';
import {
  ASSET_LIBRARY_CACHE_SCHEMA_VERSION,
  createAssetLibraryCacheKey,
} from '../src/lib/assets/library-cache';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function main() {
  const assetsPage = readProjectFile('src/app/assets/page.tsx');
  const projectsRoute = readProjectFile('src/app/api/projects/route.ts');
  const projectsGetRoute = projectsRoute.split('export async function POST')[0] || projectsRoute;

  assert(
    assetsPage.includes('readAssetLibraryCache') && assetsPage.includes('writeAssetLibraryCache'),
    '资产页必须读写本地资产缓存',
  );
  assert(
    assetsPage.includes('function toCacheSafeAssetItem') && assetsPage.includes('prompt: null'),
    '写入 IndexedDB 前必须移除长 prompt 等非列表必要字段',
  );
  assert(
    assetsPage.includes('function toCacheSafeOwner')
      && assetsPage.includes('owner: toCacheSafeOwner(item.owner)')
      && assetsPage.includes('email: null')
      && assetsPage.includes('account_type: null'),
    '写入 IndexedDB 前必须收窄 owner，不能持久化邮箱等管理员可见原始字段',
  );
  assert(
    assetsPage.includes("return value.startsWith('/') ? value : null"),
    '写入 IndexedDB 前必须过滤外部 URL，避免缓存签名链接',
  );
  assert(
    assetsPage.includes('try {\n        cached = await readAssetLibraryCache'),
    '缓存读取异常不能阻断真实网络请求',
  );
  assert(
    assetsPage.includes('正在同步最新资产，当前先显示上次加载内容。'),
    '缓存命中时必须提示后台同步状态',
  );
  assert(
    assetsPage.includes("scope !== 'project' && !(movePanelOpen && bulkTarget === 'video_project')"),
    '项目列表必须按需加载，不能首屏无条件请求',
  );
  assert(
    assetsPage.includes("user.role !== 'admin' || scope !== 'user'"),
    '管理员用户列表必须只在按用户查看时加载',
  );
  assert(
    assetsPage.includes("!movePanelOpen || bulkTarget !== 'album'"),
    '参考图集必须只在加入图集面板打开时加载',
  );
  assert(
    !projectsGetRoute.includes('ensureDefaultProjectForUser('),
    '/api/projects GET 不能无条件写默认项目成员关系',
  );

  const baseKey = createAssetLibraryCacheKey({
    userId: 'u1',
    role: 'admin',
    scope: 'history',
    type: 'video',
    status: 'all',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  const otherUserKey = createAssetLibraryCacheKey({
    userId: 'u2',
    role: 'admin',
    scope: 'history',
    type: 'video',
    status: 'all',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  const otherFilterKey = createAssetLibraryCacheKey({
    userId: 'u1',
    role: 'admin',
    scope: 'project',
    type: 'video',
    status: 'all',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: 'project-1',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });

  assert(baseKey.startsWith(`v${ASSET_LIBRARY_CACHE_SCHEMA_VERSION}|`), '缓存 key 必须包含 schema 版本');
  assert(baseKey !== otherUserKey, '缓存 key 必须按用户隔离');
  assert(baseKey !== otherFilterKey, '缓存 key 必须按筛选条件隔离');
  console.log('assets-library-performance-smoke passed');
}

main();
