import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { File } from 'node:buffer';
import ts from 'typescript';
import { sourceFunction } from './fixtures/source-function';

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
assertIncludes(
  directUpload,
  'storageProviderForAssetUrl',
  '重复素材 payload 必须按真实 URL 推断 storageProvider，不能硬编码为 r2。',
);
assertIncludes(
  directUpload,
  "startsWith(`${siteBaseUrl}/uploads/`)",
  '重复素材如果已经是本站公网 /uploads URL，也必须识别为 local-public。',
);
const assetPayloadSource = directUpload.slice(
  directUpload.indexOf('function assetRecordToPayload'),
  directUpload.indexOf('function assetRecordToResult'),
);
assertNotIncludes(
  assetPayloadSource,
  "storageProvider: 'r2'",
  '重复素材 payload 不能把本地 /uploads 素材硬标成 r2。',
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

const siteUpload = read('src/lib/assets/site-upload.ts');
assertIncludes(siteUpload, 'sameOriginPublicUrlForLocalUpload', '站内已落盘素材必须优先转成 sd2 公网 URL，不能同步等待 R2 转存。');
assertIncludes(siteUpload, 'isSameOriginPublicUploadUrl', 'raw 复用已公网化的本站 /uploads URL 时必须仍标记 local-public。');
assertIncludes(siteUpload, 'siteUploadPathFromUrl', '只有统一识别出的 /uploads/ 资源能被当成本站公开上传文件。');
assertIncludes(siteUpload, "storageProvider: 'local-public'", '站内公网 URL 路径必须标记 local-public，便于后续链路识别。');
assertIncludes(siteUpload, '历史素材本地文件不存在', '历史本地素材缺文件时必须给明确错误。');
const siteUrl = read('src/lib/assets/site-url.ts');
assertIncludes(siteUrl, 'https://sd2.youdooart.com', '站内上传资源迁移后的默认生产域名必须是 sd2.youdooart.com。');
assertIncludes(siteUrl, 'https://sd2.youdoodesign.com', '站内上传资源必须兼容历史 sd2.youdoodesign.com/uploads 旧记录。');
assertIncludes(siteUrl, 'sameOriginPublicUrlForSiteUpload', '站内上传资源必须通过统一 helper 归一到当前生产域名。');

const localStorage = read('src/lib/assets/storage.ts');
assertIncludes(localStorage, 'localUploadUrlFromAssetUrl', '底层素材去重必须识别本站公网 /uploads URL，不能只识别相对路径。');
assertNotIncludes(localStorage, 'restoreMissingLocalUploadFile', '缺原件或隐藏记录不能靠新上传静默恢复历史文件。');
assertIncludes(localStorage, 'findVerifiedOwnUpload', '重复素材必须沿当前本人原件验证，不凭相同名字复用。');
assertIncludes(localStorage, 'registerVerifiedUpload', '上传登记必须沿当前验证与原请求回执事务。');
assertIncludes(localStorage, 'siteUploadPathFromUrl', '历史已经写入本站公网 URL，底层恢复逻辑必须兼容新旧站内上传域名。');

const tasksCreate = read('src/server/video-tasks/standard-create.ts');
const ipTasksCreate = read('src/server/video-tasks/ip-create.ts');
for (const source of [tasksCreate, ipTasksCreate]) {
  assertIncludes(source, 'sameOriginPublicUrlForLocalUpload', '任务创建本地参考素材必须优先转成本站公网 URL。');
  assertIncludes(source, 'ensureSiteAssetPublicUrl', '任务创建本地参考素材有关联 asset 时必须复用统一补公网 helper。');
  assertNotIncludes(source, 'R2 上传失败', '任务创建不能再把本地素材补公网失败描述为 R2 上传失败。');
  assertNotIncludes(source, "await import('@/lib/assets/public-storage')", '任务创建不能再动态导入 R2/TOS 公网上传 helper 处理本地素材。');
}

const referenceImageSafety = read('src/lib/provider/reference-image-safety.ts');
assertNotIncludes(referenceImageSafety, "import { uploadPublicAsset }", '自动压缩参考图不能直接依赖 R2/TOS 上传。');
assertIncludes(referenceImageSafety, 'uploadSiteAsset', '自动压缩参考图必须先走本站上传链路生成 local-public URL。');
const referenceImageContentRoute = read('src/app/api/reference-images/[id]/content/route.ts');
const mediaOutlet = read('src/lib/media/outlet.ts');
const mediaPolicy = read('src/lib/access/media-policy.ts');
function assertReferenceMediaPipeline(route: string, outlet: string, policy: string) {
  const content = sourceFunction(route, 'mediaContent');
  assertMatches(content, /redirectMedia\(request, await getSession\(\), \{ type: 'reference', id:/, '参考图必须将当前身份和真实reference编号交给统一出口。');
  for (const method of ['GET', 'HEAD']) assertMatches(route, new RegExp(`export const ${method} = apiRoute\\(\\{ access: 'user', rateLimit: false \\}, mediaContent\\)`), '参考图GET/HEAD必须保留同一受权读取链。');
  const action = vm.runInNewContext(ts.transpileModule(`(${sourceFunction(outlet, 'mediaVariantAction')})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  for (const variant of ['original', 'download', 'hd', 'hd-download', 'hd-description']) assert.equal(action(variant), 'download-original', '共享读取不得绕过原件下载权限。');
  assert.equal(action('thumbnail'), 'view-thumbnail'); assert.equal(action('preview'), 'view-preview'); assert.equal(action('detail'), 'view-preview');
  const address = sourceFunction(outlet, 'mediaAddress');
  assertIncludes(address, 'await assertMedia(user, ref, mediaVariantAction(variant))', '签发地址必须重核本次媒体动作权限。');
  assertIncludes(address, 'return signUserMedia(user.id, ref, variant', '签发地址必须绑定当前账号、对象和变体。');
  assertIncludes(sourceFunction(outlet, 'redirectMedia'), 'await mediaAddress(user, ref, variant', '实际参考图读取必须使用同一受权出口。');
  assertIncludes(sourceFunction(policy, 'decideMedia'), 'rights = await referenceContentRights(user, image, db)', '参考图权限必须保留内容来源上限。');
  assertIncludes(sourceFunction(policy, 'referenceContentRights'), 'intersect(rights, ceiling)', '复制入本人图集不能抬高内容权限。');
  assertNotIncludes(content, 'mediaPreviewResponse(', '薄路由不得直接以原URL绕过统一出口。');
}
assertReferenceMediaPipeline(referenceImageContentRoute, mediaOutlet, mediaPolicy);
assert.throws(() => assertReferenceMediaPipeline(referenceImageContentRoute.replace("type: 'reference'", "type: 'asset'"), mediaOutlet, mediaPolicy));
assert.throws(() => assertReferenceMediaPipeline(referenceImageContentRoute, mediaOutlet.replace("'download-original'", "'use'"), mediaPolicy));
assert.throws(() => assertReferenceMediaPipeline(referenceImageContentRoute, mediaOutlet, mediaPolicy.replace('rights = await referenceContentRights(user, image, db)', 'rights = all()')));
const mediaPreviewResponse = read('src/lib/media/preview-response.ts');
assertIncludes(mediaPreviewResponse, 'siteUploadPathFromUrl', '实际媒体读取helper须识别历史站内上传域名。');
assertIncludes(mediaPreviewResponse, 'resolveInside(mediaRoot(', '实际媒体读取helper必须经过私有存储根与统一路径边界校验。');
const localPathBoundary = read('src/lib/fs/resolve-inside.ts');
assertIncludes(localPathBoundary, 'realpath', '统一路径校验必须核准真实路径。');
assertIncludes(localPathBoundary, 'path.relative', '统一路径校验必须核准路径属于允许根。');

const localUploadBackfill = read('scripts/backfill-local-upload-asset-urls.ts');
assertIncludes(localUploadBackfill, 'dry-run', '历史 /uploads 资产回填脚本默认必须是 dry-run。');
assertIncludes(localUploadBackfill, '--execute', '历史 /uploads 资产回填脚本必须显式 --execute 才能写库。');
assertIncludes(localUploadBackfill, 'backupSqliteDatabase', '历史 /uploads 资产回填执行前必须备份 SQLite。');
assertMatches(localUploadBackfill, /fromPrismaDir[\s\S]+fromRoot/, 'SQLite file:./dev.db 必须优先按 prisma/dev.db 定位，不能误备份项目根 0B dev.db。');
assertIncludes(localUploadBackfill, 'dbStat.size <= 0', 'SQLite 备份必须拒绝 0B 异常文件。');
assertIncludes(localUploadBackfill, "original_url: { startsWith: '/uploads/' }", '历史 /uploads 资产回填只能处理 /uploads/ 开头的记录。');

const corsReadinessSmoke = read('scripts/r2-cors-readiness-smoke.ts');
assertIncludes(corsReadinessSmoke, 'R2_DIRECT_UPLOAD_CORS_VERIFIED', 'R2 CORS readiness smoke 必须检查验收开关。');
assertIncludes(corsReadinessSmoke, 'Access-Control-Request-Method', 'R2 CORS readiness smoke 必须发真实 CORS 预检。');
assertIncludes(corsReadinessSmoke, 'Access-Control-Request-Headers', 'R2 CORS readiness smoke 必须验证 Content-Type/ETag 暴露所需 header。');
assertIncludes(corsReadinessSmoke, 'PUT', 'R2 CORS readiness smoke 必须覆盖浏览器直传 PUT。');
assertIncludes(corsReadinessSmoke, 'ETag', 'R2 CORS readiness smoke 必须检查 ETag 暴露，否则 multipart 无法完成。');

const uploadLog = read('src/lib/assets/upload-log.ts');
assertIncludes(uploadLog, 'recordAssetUploadLog', '上传阶段日志必须集中封装。');
assertIncludes(uploadLog, 'asset_upload_', '上传阶段日志 action 必须能被后台按前缀筛选。');
assertIncludes(uploadLog, 'fallbackPath', '上传日志必须记录本次使用的兜底路径，便于区分 raw/proxy/local-public。');
assertIncludes(uploadLog, 'skippedProxy', '上传日志必须记录小文件是否跳过 proxy。');
assertNotIncludes(uploadLog, 'uploadUrl', '上传日志不得记录完整签名 URL。');
assertNotIncludes(uploadLog, 'uploadToken', '上传日志不得记录 uploadToken。');
assertNotIncludes(uploadLog, 'cookie', '上传日志不得记录 cookie。');

const legacyMultipartRoutes = [
  'src/app/api/assets/upload/route.ts',
  'src/app/api/codex/assets/upload/route.ts',
  'src/app/api/tools/ultimate-canvas/upload/route.ts',
];
for (const routePath of legacyMultipartRoutes) {
  const route = read(routePath);
  assertIncludes(route, 'MULTIPART_COMPAT_MAX_SIZE_BYTES', `${routePath} 必须限制旧 multipart 兼容入口大小，避免大文件被 formData 解析拖死。`);
  assertIncludes(route, 'multipartContentLength == null', `${routePath} 缺少 Content-Length 时必须直接返回 JSON 411，不能继续 formData 解析。`);
  const parser = routePath === 'src/app/api/assets/upload/route.ts' ? 'readMultipartUpload(' : 'request.formData()';
  const guard = route.indexOf('multipartContentLength > MULTIPART_COMPAT_MAX_SIZE_BYTES');
  assert.ok(guard >= 0 && route.indexOf(parser) > guard, `${routePath} 必须在实际解析器前按 Content-Length 提前拒绝大 multipart。`);
  if (parser === 'readMultipartUpload(') assertNotIncludes(route, 'request.formData()', 'raw流式上传不得退回整包formData读取。');
}

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
const workspaceAst = ts.createSourceFile('useWorkspace.ts', workspaceHook, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const workspaceCallbacks = new Map<string, ts.ArrowFunction>();
function collectWorkspaceCallbacks(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ['uploadAsset', 'retryPendingAttach'].includes(node.name.getText(workspaceAst))
    && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(workspaceAst) === 'useCallback') {
    const callback = node.initializer.arguments[0];
    assert.ok(callback && ts.isArrowFunction(callback), '工作台上传和重试必须能核对实际回调');
    const name = node.name.getText(workspaceAst);
    assert.equal(workspaceCallbacks.has(name), false, '同名回调不能被模糊抽取');
    workspaceCallbacks.set(name, callback);
  }
  ts.forEachChild(node, collectWorkspaceCallbacks);
}
collectWorkspaceCallbacks(workspaceAst);
assert.equal(workspaceCallbacks.size, 2);
assertMatches(
  workspaceCallbacks.get('uploadAsset')!.getText(workspaceAst),
  /素材已上传成功[^\n]*加入参考区[^\n]*(?:失败|未确认)/,
  '工作台提示必须区分文件上传成功和加入失败或尚未确认，不能把未知冒充失败。',
);
assertMatches(
  workspaceCallbacks.get('retryPendingAttach')!.getText(workspaceAst),
  /associate\(scope,\s*\{\s*assetIds:\s*pendingWorkspaceAttach\.assetIds\s*\}\)/,
  '工作台重试必须沿当前账号现场，仅用原 assetIds 重试业务 JSON 关联。',
);

async function checkWorkspaceRecoveryCallbacks() {
  type Pending = { assetIds: string[]; fileNames: string[]; statusIds: string[] };
  const state = { pending: null as Pending | null, statuses: {} as Record<string, string>, error: '', uploads: 0, associations: 0 };
  const scope = { ownerId: 'fixture-workspace-owner', epoch: 3, tabId: 'fixture-tab', workspaceId: 'fixture-workspace' };
  let associationAccepted = false;
  const context: vm.Context = vm.createContext({ exports: {}, Error, crypto: { randomUUID }, pendingWorkspaceAttach: null,
    uploadAssetToHistory: async () => { state.uploads++; return 'original-uploaded-asset'; },
    isCurrent: (current: unknown) => current === scope,
    assertCurrent: (current: unknown) => assert.equal(current, scope),
    mutate: async (operation: (current: typeof scope) => Promise<unknown>) => {
      state.error = '';
      try { return await operation(scope); }
      catch (cause) { state.error = cause instanceof Error ? cause.message : String(cause); throw cause; }
    },
    associate: async (current: unknown, body: { assetIds: string[] }) => {
      assert.equal(current, scope); assert.deepEqual(Object.keys(body), ['assetIds']);
      assert.deepEqual(Array.from(body.assetIds), ['original-uploaded-asset']); state.associations++;
      if (!associationAccepted) throw new Error('原加入结果待核对');
    },
    setUploadStatuses: (value: (previous: Record<string, string>) => Record<string, string>) => { state.statuses = value(state.statuses); },
    setPendingWorkspaceAttach: (value: Pending | null) => { state.pending = value; context.pendingWorkspaceAttach = value; },
    fetch: () => assert.fail('重试业务关联不能在隔离检查中发送网络请求'),
    require: (name: string) => assert.fail(`未批准的工作台回调依赖: ${name}`),
  });
  const callbackSource = Array.from(workspaceCallbacks, ([name, callback]) => `export const ${name} = ${callback.getText(workspaceAst)};`).join('\n');
  vm.runInContext(ts.transpileModule(callbackSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, context, { filename: 'workspace-upload-recovery.engineering.ts' });
  const callbacks = context.exports as { uploadAsset: (file: File) => Promise<void>; retryPendingAttach: () => Promise<void> };
  await callbacks.uploadAsset(new File([Buffer.from('fixture')], 'original.png', { type: 'image/png' }));
  assert.equal(state.uploads, 1); assert.equal(state.associations, 1);
  assert.match(state.error, /素材已上传成功[^\n]*加入参考区[^\n]*(?:失败|未确认)/);
  assert.ok(state.pending); const originalPending = JSON.stringify(state.pending);
  assert.deepEqual(Array.from(state.pending.assetIds), ['original-uploaded-asset']);
  assert.deepEqual(Array.from(state.pending.fileNames), ['original.png']);
  assert.equal(Object.values(state.statuses).filter(status => status === 'failed').length, 1);
  await callbacks.retryPendingAttach();
  assert.equal(state.uploads, 1); assert.equal(state.associations, 2);
  assert.equal(JSON.stringify(state.pending), originalPending, '原关联未知时必须保留同一 assetIds 与状态编号');
  associationAccepted = true;
  await callbacks.retryPendingAttach();
  assert.equal(state.uploads, 1); assert.equal(state.associations, 3);
  assert.equal(state.pending, null); assert.deepEqual(Object.keys(state.statuses), []);
  await callbacks.retryPendingAttach();
  assert.equal(state.uploads, 1); assert.equal(state.associations, 3, '确认加入后不得再次执行旧关联');
}

const uploadedPicker = read('src/components/UploadedImagePicker.tsx');
assertIncludes(uploadedPicker, '<ResourceLibraryPicker {...props}', '兼容弹窗须将原回调完整交给当前共享素材选择器。');
const sharedPicker = read('src/components/ResourceLibraryPicker.tsx');
assertIncludes(sharedPicker, 'uploadReceipts.current.set(id, result)', '共享选择器须保留已上传素材的原回执。');
assertIncludes(sharedPicker, 'Keep uploaded IDs even when metadata retrieval fails', '素材信息读取失败不得重传已成功文件。');
assertIncludes(sharedPicker, 'imports.current.get(item.identity)', '导入后重试添加必须复用已有素材编号。');
assertIncludes(sharedPicker, '素材已导入，信息暂不可用；请重试添加，不必重传', '已导入与业务添加失败必须明确分开。');
assertIncludes(sharedPicker, 'await onConfirmSelection(uniqueItems)', '按对象添加必须传已核权的原素材。');
assertIncludes(sharedPicker, 'await onConfirm(uniqueItems.map(i => i.id), uniqueItems)', '旧按ID添加也须复用原素材，不重传文件。');
assertIncludes(sharedPicker, 'confirmationSession !== session.current', '添加回调须保留账号与目标现场隔离。');

const templatePicker = read('src/components/templates/TemplateBoundImagePicker.tsx');
assertIncludes(templatePicker, '<UploadedImagePicker', '模板绑定图必须复用保留原素材回执的共享选择器。');
assertIncludes(templatePicker, 'onConfirmSelection={choose}', '绑定须交给共享选择器的对象确认，失败后保留同一素材。');
assertIncludes(templatePicker, "return { success: false, message: cause instanceof Error ? cause.message : '绑定失败，请重试' }", '绑定失败不得关闭选择器或重新上传。');
assertIncludes(templatePicker, 'asset_id: item.assetId!', '上传结果必须使用原 assetId 绑定。');
assertIncludes(templatePicker, 'onUploadFile={(file, onProgress) => uploadFileToHistory(file, { onProgress })}', '上传须保留原历史上传链路。');

const feedbackWidget = read('src/components/FeedbackWidget.tsx');
assertIncludes(feedbackWidget, 'assetId?: string', '反馈截图状态必须保留上传后的 assetId。');
assertIncludes(feedbackWidget, 'retrySubmitUploadedAssets', '反馈提交失败必须允许复用已上传截图重新提交。');
assertIncludes(feedbackWidget, '截图已上传成功，但反馈提交失败', '反馈提交失败提示必须区分截图上传和反馈入库。');

void checkWorkspaceRecoveryCallbacks().then(() => { console.log('upload-root-cure-smoke: ok'); }).catch((error: unknown) => {
  console.error(error); process.exitCode = 1;
});
