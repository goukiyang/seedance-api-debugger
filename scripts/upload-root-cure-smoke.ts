import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(source: string, needle: string, message: string) {
  assert.ok(source.includes(needle), message);
}

function assertMatches(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message);
}

function assertNotIncludes(source: string, needle: string, message: string) {
  assert.ok(!source.includes(needle), message);
}

const directUpload = read('src/lib/assets/direct-upload.ts');
assertIncludes(
  directUpload,
  'R2_DIRECT_UPLOAD_CORS_VERIFIED',
  '浏览器直传必须有独立的 R2 CORS 已验收开关，不能只靠 R2_DIRECT_UPLOAD_ENABLED。',
);
assertIncludes(
  directUpload,
  'createMultipartUploadTicket',
  '大文件必须提供 multipart start 逻辑，不能继续只依赖单个长请求。',
);
assertIncludes(
  directUpload,
  'signMultipartUploadPart',
  '大文件 multipart 必须按 part 生成短期上传地址。',
);
assertIncludes(
  directUpload,
  'completeMultipartUpload',
  '大文件 multipart 必须有完成合并并登记 Asset 的服务端逻辑。',
);
assertIncludes(
  directUpload,
  'abortMultipartUpload',
  '大文件 multipart 必须支持失败或取消后的清理。',
);

const multipartRoutes = [
  'src/app/api/assets/multipart/start/route.ts',
  'src/app/api/assets/multipart/sign-part/route.ts',
  'src/app/api/assets/multipart/complete/route.ts',
  'src/app/api/assets/multipart/abort/route.ts',
];
for (const routePath of multipartRoutes) {
  const route = read(routePath);
  assertIncludes(route, 'getSession()', `${routePath} 必须要求登录。`);
  assertNotIncludes(route, 'request.formData()', `${routePath} 不应接收 multipart 文件体。`);
}

const fileUpload = read('src/lib/http/file-upload.ts');
assertIncludes(
  fileUpload,
  'MULTIPART_UPLOAD_MIN_SIZE_BYTES',
  '前端必须只对大文件启用 multipart，小文件继续走简单上传链路。',
);
assertMatches(
  fileUpload,
  /file\.type\.startsWith\('video\/'\)[\s\S]+file\.size\s*>\s*MULTIPART_UPLOAD_MIN_SIZE_BYTES/,
  'multipart 触发条件必须优先面向大视频文件。',
);
assertIncludes(
  fileUpload,
  '/api/assets/multipart/start',
  '前端必须调用 multipart start 接口。',
);
assertIncludes(
  fileUpload,
  '/api/assets/multipart/sign-part',
  '前端必须逐片申请上传地址。',
);
assertIncludes(
  fileUpload,
  '/api/assets/multipart/complete',
  '前端必须调用 multipart complete 接口登记 Asset。',
);
assertIncludes(
  fileUpload,
  '/api/assets/multipart/abort',
  '前端在分块上传不可恢复失败时必须调用 multipart abort 清理未完成分片。',
);
assertMatches(
  fileUpload,
  /abortMultipartUpload[\s\S]+fetch\('\/api\/assets\/multipart\/abort'/,
  '前端 multipart abort 必须集中封装，不能只靠后端接口存在。',
);
assertIncludes(
  fileUpload,
  'sessionStorage',
  'multipart 上传必须保留本轮断点状态，重试时不能默认从头开始。',
);

const corsReadinessSmoke = read('scripts/r2-cors-readiness-smoke.ts');
assertIncludes(corsReadinessSmoke, 'R2_DIRECT_UPLOAD_CORS_VERIFIED', 'R2 CORS readiness smoke 必须检查验收开关。');
assertIncludes(corsReadinessSmoke, 'Access-Control-Request-Method', 'R2 CORS readiness smoke 必须发真实 CORS 预检。');
assertIncludes(corsReadinessSmoke, 'Access-Control-Request-Headers', 'R2 CORS readiness smoke 必须验证 Content-Type/ETag 暴露所需 header。');
assertIncludes(corsReadinessSmoke, 'PUT', 'R2 CORS readiness smoke 必须覆盖浏览器直传 PUT。');
assertIncludes(corsReadinessSmoke, 'ETag', 'R2 CORS readiness smoke 必须检查 ETag 暴露，否则 multipart 无法完成。');

const uploadLog = read('src/lib/assets/upload-log.ts');
assertIncludes(uploadLog, 'recordAssetUploadLog', '上传阶段日志必须集中封装。');
assertIncludes(uploadLog, 'asset_upload_', '上传阶段日志 action 必须能被后台按前缀筛选。');
assertNotIncludes(uploadLog, 'uploadUrl', '上传日志不得记录完整签名 URL。');
assertNotIncludes(uploadLog, 'uploadToken', '上传日志不得记录 uploadToken。');
assertNotIncludes(uploadLog, 'cookie', '上传日志不得记录 cookie。');

const uploadRoutes = [
  'src/app/api/assets/upload-ticket/route.ts',
  'src/app/api/assets/upload-proxy/route.ts',
  'src/app/api/assets/upload-complete/route.ts',
  'src/app/api/assets/upload/route.ts',
  ...multipartRoutes,
];
for (const routePath of uploadRoutes) {
  const route = read(routePath);
  assertIncludes(route, 'recordAssetUploadLog', `${routePath} 必须记录上传阶段日志。`);
}

const adminUploadsRoute = read('src/app/api/admin/uploads/recent/route.ts');
assertIncludes(adminUploadsRoute, 'getAdminUser(request)', '上传诊断后台接口必须只允许管理员读取。');
assertIncludes(adminUploadsRoute, "startsWith: 'asset_upload_'", '后台上传诊断必须只读取上传阶段日志。');
assertNotIncludes(adminUploadsRoute, 'uploadToken', '后台诊断输出不能暴露 uploadToken。');

const workspaceHook = read('src/lib/hooks/useWorkspace.ts');
assertIncludes(
  workspaceHook,
  'PendingWorkspaceAttach',
  '工作台必须保存上传成功但加入参考区失败的 assetId。',
);
assertIncludes(
  workspaceHook,
  'retryPendingAttach',
  '工作台必须提供只重试业务挂载的恢复函数。',
);
assertIncludes(
  workspaceHook,
  '素材已上传成功，但加入参考区失败',
  '工作台挂载失败提示必须区分文件上传成功和加入参考区失败。',
);
assertMatches(
  workspaceHook,
  /retryPendingAttach[\s\S]+attachUploadedAssetsToWorkspace\(pendingWorkspaceAttach\.assetIds\)/,
  '工作台重试挂载必须只调用业务 JSON 挂载，不能重新上传文件。',
);

const uploadedPicker = read('src/components/UploadedImagePicker.tsx');
assertIncludes(uploadedPicker, 'PendingPickerAttach', '上传历史弹窗必须保存上传成功但加入参考区失败的 assetId。');
assertIncludes(uploadedPicker, 'retryPendingAttach', '上传历史弹窗失败后必须允许不重传文件直接重试加入参考区。');
assertIncludes(uploadedPicker, '素材已上传成功，但加入参考区失败', '上传历史弹窗必须区分文件上传成功和加入参考区失败。');
assertMatches(
  uploadedPicker,
  /retryPendingAttach[\s\S]+attachUploadedAssets\(pendingAttach\)/,
  '上传历史弹窗重试必须只调用业务挂载逻辑，不能重新上传文件。',
);
assertMatches(
  uploadedPicker,
  /attachUploadedAssets[\s\S]+await onConfirm\(assetIds,\s*assets\)/,
  '上传历史弹窗待挂载恢复必须复用已上传 assetId 调 onConfirm。',
);

const templatePicker = read('src/components/templates/TemplateBoundImagePicker.tsx');
assertIncludes(templatePicker, 'pendingUploadedImage', '模板绑定图上传后必须保留待绑定的 assetId。');
assertIncludes(templatePicker, 'retryPendingUploadedImage', '模板绑定图失败后必须允许不重传文件直接重试绑定。');
assertIncludes(templatePicker, '图片已上传成功，但绑定失败', '模板绑定图必须区分上传成功和业务绑定失败。');

const feedbackWidget = read('src/components/FeedbackWidget.tsx');
assertIncludes(feedbackWidget, 'assetId?: string', '反馈截图状态必须保留上传后的 assetId。');
assertIncludes(feedbackWidget, 'retrySubmitUploadedAssets', '反馈提交失败必须允许复用已上传截图重新提交。');
assertIncludes(feedbackWidget, '截图已上传成功，但反馈提交失败', '反馈提交失败提示必须区分截图上传和反馈入库。');

console.log('upload-root-cure-smoke: ok');
