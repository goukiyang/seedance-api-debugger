import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const routeSource = read('src/app/api/reference-albums/[id]/images/route.ts');
const clientSource = read('src/app/collections/[id]/ReferenceAlbumDetailClient.tsx');
const uploadHandlerMatch = clientSource.match(/const handleUpload = async[\s\S]*?const handleUseForGeneration = async/);
const uploadHandler = uploadHandlerMatch?.[0] || '';

assert(
  routeSource.includes('CURRENT_UPLOAD_ENTRYPOINT_UPGRADED'),
  '图集图片接口必须识别旧 multipart 请求并返回稳定 JSON 错误码。',
);
assert(
  !routeSource.includes('request.formData()'),
  '图集图片接口不得再读取 multipart 文件体，避免请求中断后卡死业务保存。',
);
assert(
  !routeSource.includes('uploadSiteAsset(buffer'),
  '图集图片接口不得再承担文件上传，文件上传必须先走统一 Asset 链路。',
);
assert(
  routeSource.includes("action: 'reference_album_add_assets'"),
  '图集图片接口仍必须记录 assetId 挂载操作日志。',
);
assert(
  uploadHandler.includes('uploadFileAsAsset(file, {'),
  '图集页上传必须先调用统一 Asset 上传 helper。',
);
assert(
  uploadHandler.includes('assetIds'),
  '图集页必须收集 assetIds 后挂载到图集。',
);
assert(
  uploadHandler.includes('pendingAlbumAttach'),
  '图集页必须在挂载失败时保留可重试的 assetIds。',
);
assert(
  clientSource.includes('fetch(`/api/reference-albums/${albumId}/images`') && clientSource.includes('JSON.stringify({') && clientSource.includes('assetIds'),
  '图集页必须用 JSON assetIds 调用当前图集图片接口。',
);
assert(
  !uploadHandler.includes('new FormData()'),
  '图集页不得再把文件作为 FormData 提交到业务接口。',
);

console.log('reference-album-duplicate-upload-smoke: ok');
