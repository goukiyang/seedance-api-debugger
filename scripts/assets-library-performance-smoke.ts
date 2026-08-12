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
  const assetLibraryRoute = readProjectFile('src/app/api/assets/library/route.ts');
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
    assetsPage.includes("type AssetView = AssetScope | 'enhance'")
      && assetsPage.includes("id: 'enhance', label: '视频超分'")
      && assetsPage.includes("params.set('enhance', enhanceFilter)")
      && assetsPage.includes('asset-card-badge-enhance')
      && assetsPage.includes('asset-card-enhance-trigger'),
    '资产页必须提供视频超分专属标签，并让超分结果/可超分视频更明显',
  );
  assert(
    assetsPage.includes('ASSET_SHOW_UPLOADS_STORAGE_KEY')
      && assetsPage.includes('readSavedShowUploadedAssets')
      && assetsPage.includes('asset-library-source-toggle')
      && assetsPage.includes("params.set('include_uploads', showUploadedAssets ? 'true' : 'false')")
      && assetsPage.includes('showUploadedAssets && ('),
    '资产页上传素材必须走独立开关，默认不显示上传面板和上传来源素材',
  );
  assert(
    assetsPage.includes('selectionMode')
      && assetsPage.includes('asset-library-select-toggle')
      && assetsPage.includes('(selectionMode || selected) &&')
      && assetsPage.includes('if (!selectionMode) return;'),
    '资产页多选框必须由选择模式开关控制，不能常驻每张卡片',
  );
  assert(
    assetsPage.includes("const [status, setStatus] = useState<AssetStatus>('succeeded')")
      && assetsPage.includes("{ id: 'all', label: '全部状态（含失败）' }")
      && assetsPage.includes("setStatus('succeeded')"),
    '资产页默认必须只看已完成资产，全部状态必须明确包含失败项',
  );
  assert(
    assetsPage.includes('function mediaFallbackLabel')
      && assetsPage.includes("return '视频素材'")
      && assetsPage.includes("return '暂无截图'"),
    '资产卡片无缩略图时必须显示明确素材/截图状态，不能让用户误判为坏图',
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
  assert(
    assetLibraryRoute.includes('const ENHANCE_FILTERS')
      && assetLibraryRoute.includes("options.enhance === 'all'")
      && assetLibraryRoute.includes("generation_mode: 'enhance_video'")
      && assetLibraryRoute.includes("provider: 'volcengine_mediakit'")
      && assetLibraryRoute.includes("options.enhance !== 'none'"),
    '/api/assets/library 必须支持 enhance=all 服务端过滤',
  );
  assert(
    assetLibraryRoute.includes("const status = enumParam(searchParams.get('status'), STATUSES, 'succeeded')"),
    '/api/assets/library 默认必须只返回已完成视频任务，避免失败任务占据资产页主视图',
  );
  assert(
    assetLibraryRoute.includes("const includeUploads = searchParams.get('include_uploads') === 'true'")
      && assetLibraryRoute.includes('includeUploads\n        ? loadAssetItems')
      && assetLibraryRoute.includes("include_uploads: includeUploads"),
    '/api/assets/library 必须默认排除自己上传素材，并只在 include_uploads=true 时返回',
  );
  assert(
    assetLibraryRoute.includes("const thumbnailUrl = asset.type === 'image'")
      && assetLibraryRoute.includes('asset.thumbnail_url || asset.original_url')
      && assetLibraryRoute.includes(': asset.thumbnail_url'),
    'Asset 视频/音频不能用 original_url 冒充图片缩略图，避免 mp4/mp3 被放进 img',
  );
  assert(
    assetLibraryRoute.includes('function legacyAssetOwnerSummary')
      && assetLibraryRoute.includes('ownerById.get(asset.owner_id)')
      && assetLibraryRoute.includes('历史默认用户'),
    'Asset 必须带 owner 信息，旧 default-user 也要有稳定用户兜底',
  );
  assert(
    assetLibraryRoute.includes('function shouldIncludeActiveLibraryMedia')
      && assetLibraryRoute.includes("options.status !== 'hidden' && !shouldIncludeActiveLibraryMedia(options.status)")
      && assetLibraryRoute.includes("status: options.status === 'hidden' ? 'deleted' : 'active'"),
    '失败/排队/取消等任务状态筛选不能混入 active 上传素材或参考图',
  );

  const baseKey = createAssetLibraryCacheKey({
    view: 'history',
    userId: 'u1',
    role: 'admin',
    scope: 'history',
    type: 'video',
    enhance: 'none',
    includeUploads: false,
    status: 'succeeded',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  const otherUserKey = createAssetLibraryCacheKey({
    view: 'history',
    userId: 'u2',
    role: 'admin',
    scope: 'history',
    type: 'video',
    enhance: 'none',
    includeUploads: false,
    status: 'succeeded',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  const otherFilterKey = createAssetLibraryCacheKey({
    view: 'history',
    userId: 'u1',
    role: 'admin',
    scope: 'project',
    type: 'video',
    enhance: 'none',
    includeUploads: false,
    status: 'succeeded',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: 'project-1',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  const enhanceViewKey = createAssetLibraryCacheKey({
    view: 'enhance',
    userId: 'u1',
    role: 'admin',
    scope: 'history',
    type: 'video',
    enhance: 'all',
    includeUploads: false,
    status: 'all',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });

  assert(baseKey.startsWith(`v${ASSET_LIBRARY_CACHE_SCHEMA_VERSION}|`), '缓存 key 必须包含 schema 版本');
  assert(baseKey !== otherUserKey, '缓存 key 必须按用户隔离');
  assert(baseKey !== otherFilterKey, '缓存 key 必须按筛选条件隔离');
  assert(baseKey !== enhanceViewKey, '缓存 key 必须区分普通资产视图和视频超分视图');
  const uploadedAssetsKey = createAssetLibraryCacheKey({
    view: 'history',
    userId: 'u1',
    role: 'admin',
    scope: 'history',
    type: 'video',
    enhance: 'none',
    includeUploads: true,
    status: 'succeeded',
    sort: 'created_desc',
    groupBy: 'date',
    projectId: '',
    ownerUserId: '',
    keyword: '',
    page: 1,
  });
  assert(baseKey !== uploadedAssetsKey, '缓存 key 必须区分是否显示自己上传素材');
  console.log('assets-library-performance-smoke passed');
}

main();
