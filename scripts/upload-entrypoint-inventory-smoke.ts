import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const fileUploadHelper = read('src/lib/http/file-upload.ts');
assert.match(
  fileUploadHelper,
  /export\s+(?:const|async function)\s+uploadFileAsAsset\b|export\s*\{[\s\S]*uploadFileToHistory\s+as\s+uploadFileAsAsset/,
  '统一上传 helper 必须导出 uploadFileAsAsset，业务页面不要继续使用“上传历史”命名。',
);

const referenceClient = read('src/app/collections/[id]/ReferenceAlbumDetailClient.tsx');
const referenceUploadHandler = referenceClient.match(/const handleUpload = async[\s\S]*?const handleUseForGeneration = async/)?.[0] || '';
assert.match(referenceUploadHandler, /uploadFileAsAsset\(file,\s*\{/, '图集页必须先把文件上传成 Asset。');
assert.match(referenceUploadHandler, /assetIds/, '图集页必须收集 assetIds 后再挂载到图集。');
assert.match(referenceClient, /JSON\.stringify\(\{[\s\S]*assetIds/, '图集页挂载图集必须使用 JSON assetIds。');
assert.match(referenceUploadHandler, /pendingAlbumAttach/, '图集页必须在挂载失败后保留可重试的 assetIds。');
assert.doesNotMatch(referenceUploadHandler, /new FormData\(/, '图集页不得再把文件 FormData 直接提交到图集业务接口。');
assert.doesNotMatch(referenceUploadHandler, /requestJsonWithUploadProgress/, '图集页不得绕过统一 Asset 上传 helper。');

const referenceRoute = withoutComments(read('src/app/api/reference-albums/[id]/images/route.ts'));
assert.match(referenceRoute, /CURRENT_UPLOAD_ENTRYPOINT_UPGRADED/, '图集图片接口必须给旧 multipart 调用返回稳定 JSON 错误码。');
assert.match(referenceRoute, /assetIds/, '图集图片接口必须保留 JSON assetIds 挂载能力。');
assert.doesNotMatch(referenceRoute, /request\.formData\(/, '图集图片接口不得再读取 multipart 文件体。');
assert.doesNotMatch(referenceRoute, /uploadSiteAsset\(/, '图集图片接口不得再承担文件上传。');

const feedbackWidget = read('src/components/FeedbackWidget.tsx');
assert.match(feedbackWidget, /uploadFileAsAsset\(item\.file,\s*\{/, '反馈截图必须走统一 Asset 上传 helper。');
assert.match(feedbackWidget, /const imageUrl = asset\.originalUrl[\s\S]*imageUrl,/, '反馈截图提交必须复用 Asset 返回的 URL。');
assert.doesNotMatch(feedbackWidget, /\/api\/feedback\/upload/, '反馈截图前端不得再提交到旧业务上传接口。');
assert.doesNotMatch(feedbackWidget, /new FormData\(/, '反馈截图前端不得再创建直传业务接口的 FormData。');

const feedbackRoute = withoutComments(read('src/app/api/feedback/upload/route.ts'));
assert.match(feedbackRoute, /CURRENT_UPLOAD_ENTRYPOINT_UPGRADED/, '旧反馈截图上传接口必须返回稳定 JSON 错误码。');
assert.doesNotMatch(feedbackRoute, /request\.formData\(/, '旧反馈截图上传接口不得再读取 multipart 文件体。');
assert.doesNotMatch(feedbackRoute, /uploadAsset\(/, '旧反馈截图上传接口不得再写入文件。');

const seedancePanel = read('src/components/SeedanceAssetPanel.tsx');
const seedanceUploadHandler = seedancePanel.match(/const handleLocalUpload = useCallback\(async[\s\S]*?if \(!visible\) return null/)?.[0] || '';
assert.match(seedanceUploadHandler, /uploadFileAsAsset\(uploadFile,\s*\{/, '官方素材面板必须先把文件上传成 Asset。');
assert.match(seedanceUploadHandler, /assetId:\s*asset\.id/, '官方素材创建必须把 assetId 发给 upload-and-create。');
assert.match(seedanceUploadHandler, /JSON\.stringify\(\{[\s\S]*assetId/, '官方素材创建必须使用 JSON assetId。');
assert.doesNotMatch(seedanceUploadHandler, /new FormData\(/, '官方素材面板不得再直接提交文件到 upload-and-create。');
assert.doesNotMatch(seedanceUploadHandler, /requestJsonWithUploadProgress/, '官方素材面板不得绕过统一 Asset 上传 helper。');

const uploadAndCreateRoute = withoutComments(read('src/app/api/assets/upload-and-create/route.ts'));
assert.match(uploadAndCreateRoute, /request\.json\(\)/, 'upload-and-create 必须读取 JSON 请求体。');
assert.match(uploadAndCreateRoute, /assetId/, 'upload-and-create 必须以 assetId 创建官方素材。');
assert.match(uploadAndCreateRoute, /ensureSiteAssetPublicUrl/, 'upload-and-create 必须确保 Asset URL 可被官方访问。');
assert.match(uploadAndCreateRoute, /findActiveByFileHash/, 'upload-and-create 必须复用同 hash 的官方素材。');
assert.match(uploadAndCreateRoute, /CURRENT_UPLOAD_ENTRYPOINT_UPGRADED/, 'upload-and-create 必须给旧 multipart 调用返回稳定 JSON 错误码。');
assert.doesNotMatch(uploadAndCreateRoute, /request\.formData\(/, 'upload-and-create 不得再读取 multipart 文件体。');
assert.doesNotMatch(uploadAndCreateRoute, /Buffer\.from\(await file\.arrayBuffer\(\)\)/, 'upload-and-create 不得再把文件读入内存上传。');
assert.doesNotMatch(uploadAndCreateRoute, /uploadPublicAsset\(/, 'upload-and-create 不得再负责公网文件上传。');

console.log('upload-entrypoint-inventory-smoke: ok');
