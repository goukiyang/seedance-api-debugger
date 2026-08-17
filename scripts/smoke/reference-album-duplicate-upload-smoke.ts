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
  routeSource.includes("contentType.includes('multipart/form-data')"),
  '图集图片接口必须识别 multipart 上传请求。',
);
assert(
  routeSource.includes('function computeUploadHash(buffer: Buffer)'),
  '图集上传必须先计算文件 hash。',
);
assert(
  routeSource.includes('computeUploadHash(buffer)'),
  '图集上传必须保留 hash 计算，避免重复上传逻辑回归。',
);
assert(
  routeSource.includes('reused_existing_asset'),
  '复用旧资产时必须写入可审计 metadata。',
);
assert(
  routeSource.includes('uploadSiteAsset(buffer, file.name, file.type, file.size, user.id)'),
  '图集上传必须统一走站点上传能力，由存储层处理跨用户复用。',
);
assert(
  routeSource.includes('action: \'reference_album_upload_images\''),
  '图集文件上传必须写入独立操作日志。',
);
assert(
  uploadHandler.includes('new FormData()') && uploadHandler.includes("formData.append('file', file)"),
  '图集页上传必须把选择的图片作为 FormData 提交。',
);
assert(
  uploadHandler.includes('fetch(`/api/reference-albums/${albumId}/images`'),
  '图集页上传必须直接提交到当前图集图片接口。',
);
assert(
  !uploadHandler.includes("fetch('/api/assets/upload'"),
  '图集页上传不能再先走 /api/assets/upload 两步流。',
);

console.log('reference-album-duplicate-upload-smoke: ok');
