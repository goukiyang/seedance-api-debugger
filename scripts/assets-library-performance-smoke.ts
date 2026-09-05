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
  const clientLayout = readProjectFile('src/app/ClientLayout.tsx');
  const appShell = readProjectFile('src/components/AppShell.tsx');
  const composerTopbar = readProjectFile('src/components/ComposerTopbar.tsx');
  const accountMenu = readProjectFile('src/components/AccountMenu.tsx');
  const appSessionContext = readProjectFile('src/lib/context/AppSessionContext.tsx');
  const interactionMetrics = readProjectFile('src/lib/performance/interaction-metrics.tsx');
  const assetCache = readProjectFile('src/lib/assets/library-cache.ts');
  const assetLibraryRoute = readProjectFile('src/app/api/assets/library/route.ts');
  const projectsRoute = readProjectFile('src/app/api/projects/route.ts');
  const adminUsersRoute = readProjectFile('src/app/api/admin/users/route.ts');
  const globalCss = readProjectFile('src/app/globals.css');
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
    assetsPage.includes("import { cacheSafeAssetUrl } from '@/lib/assets/library-cache-policy'")
      && assetsPage.includes('thumbnailUrl: cacheSafeAssetUrl(item.thumbnailUrl)')
      && assetsPage.includes('previewUrl: cacheSafeAssetUrl(item.previewUrl)')
      && assetsPage.includes('downloadUrl: cacheSafeAssetUrl(item.downloadUrl)'),
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
    !assetsPage.includes("item.project?.name || '未归属项目'} · {formatDateTime(item.createdAt)"),
    '资产卡片列表视图不能再单独显示项目和日期第三行，避免卡片信息分行过多',
  );
  assert(
    assetsPage.includes('function formatCnyCostBadge')
      && assetsPage.includes("item.providerCostCurrency?.trim().toUpperCase() !== 'USD'")
      && assetsPage.includes('providerFinalAmountMicros')
      && assetsPage.includes('providerOfficialAmountMicros')
      && assetsPage.includes('costAmountToCnyEstimate({')
      && assetsPage.includes('className="asset-card-badge asset-card-cost-badge"')
      && assetsPage.includes('const cnyCostBadge = formatCnyCostBadge(item)')
      && !assetsPage.includes('return `实扣 ')
      && !assetsPage.includes("'' : ' USD'")
      && !assetsPage.includes('const usdCostBadge = formatUsdCostBadge(item)')
      && !assetsPage.includes('function formatActualCost')
      && !assetsPage.includes('return `实扣 ${amount} 点`'),
    '资产卡片实际扣费必须使用 Provider USD 官方成本换算成人民币短金额，不能带“实扣”或“USD”文案，也不能把平台点数放进下方信息',
  );
  assert(
    assetsPage.includes("import { costAmountToCnyEstimate, usdToCnyRateText } from '@/lib/costs/currency'")
      && assetsPage.includes('function formatAssetCostBreakdown')
      && assetsPage.includes('const activeItemCostBreakdown = activeItem ? formatAssetCostBreakdown(activeItem) : null')
      && assetsPage.includes('className="asset-detail-cost-panel"')
      && assetsPage.includes('美金扣费')
      && assetsPage.includes('人民币扣费')
      && assetsPage.includes('activeItemCostBreakdown.usd')
      && assetsPage.includes('activeItemCostBreakdown.cny')
      && assetsPage.includes('activeItemCostBreakdown.rate'),
    '资产详情抽屉预览区必须显示完整美金扣费和人民币扣费，并复用统一汇率 helper',
  );
  assert(
    globalCss.includes('.asset-card-top-right-badges')
      && globalCss.includes('.asset-card-cost-badge')
      && globalCss.includes('top: 8px;')
      && globalCss.includes('right: 8px;')
      && !globalCss.includes('.asset-card-top-left-badges'),
    '资产卡片 USD 成本角标必须定位在视频缩略图右上角',
  );
  assert(
    globalCss.includes('.asset-detail-cost-panel')
      && globalCss.includes('.asset-detail-cost-panel strong')
      && globalCss.includes('.asset-detail-cost-panel small'),
    '资产详情抽屉成本金额必须有独立样式，保证美金和人民币金额清晰可读',
  );
  assert(
    globalCss.includes('@media (max-width: 980px)')
      && globalCss.includes('.composer-topbar-nav {\n    display: none;')
      && globalCss.includes('.composer-topbar-credit {\n    display: none;')
      && globalCss.includes('.account-menu-composer .account-menu-name {\n    max-width: 136px;'),
    '窄桌面宽度必须提前精简顶部导航，避免账号退出按钮被挤到右侧滚动条下',
  );
  assert(
    globalCss.includes('top: calc(var(--composer-topbar-height, 48px) + 8px);')
      && globalCss.includes('right: max(12px, env(safe-area-inset-right));')
      && globalCss.includes('scrollbar-gutter: stable;')
      && globalCss.includes('.asset-detail-header {\n  position: sticky;'),
    '资产详情抽屉必须避开顶部栏和右侧滚动条，并保持关闭区可见',
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
    assetLibraryRoute.includes('providerCostCurrency: string | null')
      && assetLibraryRoute.includes('provider_cost_currency: true')
      && assetLibraryRoute.includes('providerOfficialAmountMicros: task.provider_official_amount_micros')
      && !assetLibraryRoute.includes('actualCost: task.actual_cost'),
    '/api/assets/library 必须透出 Provider 官方 USD 成本字段给视频角标，不能把平台点数 actual_cost 当美金',
  );
  assert(
    assetLibraryRoute.includes("const thumbnailUrl = asset.type === 'image'")
      && assetLibraryRoute.includes('const originalUrl = publicAssetUrl(asset.original_url)')
      && assetLibraryRoute.includes('const storedThumbnailUrl = publicAssetUrl(asset.thumbnail_url)')
      && assetLibraryRoute.includes('? storedThumbnailUrl || originalUrl')
      && assetLibraryRoute.includes(': storedThumbnailUrl'),
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
  assert(
    clientLayout.includes('<AppSessionProvider>')
      && clientLayout.includes('<InteractionMetricsReporter />')
      && appShell.includes('useAppSession()')
      && !appShell.includes("fetch('/api/auth/me'")
      && !appShell.includes("fetch('/api/me/credits'"),
    '全局导航必须复用 AppSessionContext，页面切换不能重复打 me/credits',
  );
  assert(
    appShell.includes('clearSession')
      && composerTopbar.includes('onSessionClear')
      && accountMenu.includes('onSessionClear?.()'),
    '共享登录态必须在退出登录后清理，避免旧头像、旧点数残留',
  );
  assert(
    appSessionContext.includes('CREDIT_CACHE_TTL_MS')
      && appSessionContext.includes('hasLoadedUserRef')
      && appSessionContext.includes('lastCreditsAtRef')
      && appSessionContext.includes('userLoadError')
      && appSessionContext.includes('clearSession'),
    'AppSessionContext 必须合并用户/点数请求、缓存短期点数结果，并区分登录状态加载异常',
  );
  assert(
    interactionMetrics.includes('assetGridProfilerOnRender')
      && interactionMetrics.includes('PerformanceObserver')
      && interactionMetrics.includes('longtask')
      && assetsPage.includes('<Profiler id="AssetLibraryGrid"'),
    '资产页必须保留开发环境交互性能探针，方便定位页面切换和网格重绘卡顿',
  );
  assert(
    assetCache.includes('CACHE_TTL_MS')
      && assetCache.includes('Date.now() - entry.savedAt')
      && assetCache.includes('deleteAssetLibraryCacheForUser')
      && assetsPage.includes('const invalidateAssetCache = useCallback')
      && assetsPage.includes('await invalidateAssetCache()'),
    '资产缓存必须有过期时间，并在上传/移动/加入图集后先按当前用户失效再刷新',
  );
  assert(
    assetsPage.includes('snapshotCardRects')
      && assetsPage.includes('cardRectSnapshot.current')
      && assetsPage.includes('requestAnimationFrame')
      && assetsPage.includes('cancelAnimationFrame')
      && assetsPage.includes('sameAssetIdList'),
    '资产页拖拽框选必须使用卡片位置快照和 requestAnimationFrame，避免每次移动都同步量 DOM',
  );
  assert(
    assetsPage.includes('lite=true')
      && projectsRoute.includes("request.nextUrl.searchParams.get('lite') === 'true'")
      && projectsRoute.includes('const projects = (includeAll')
      && adminUsersRoute.includes("request.nextUrl.searchParams.get('lite') === 'true'"),
    '资产页辅助数据必须使用 projects/admin-users 轻量模式，减少页面切换时的接口负担',
  );
  assert(
    globalCss.includes('content-visibility: auto')
      && globalCss.includes('contain-intrinsic-size')
      && globalCss.includes('contain: layout paint style')
      && globalCss.includes('.shell-nav-link:hover')
      && globalCss.includes('.composer-topbar-nav-btn:hover'),
    '资产分组和卡片媒体必须启用渲染隔离，导航点击也要降低 hover 位移动画成本',
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
