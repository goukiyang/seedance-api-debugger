/**
 * POST /api/video/create
 *
 * 功能：
 * - workspace 素材自动注入
 * - prompt 图号验证
 * - 任务快照创建
 * - 重复提交保护（payload hash）
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { createVideoTask, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import { buildContentArray } from '@/lib/provider/jimeng';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import type { CreateVideoInput, GenerationMode } from '@/types';
import type { AssetMapping } from '@/lib/assets/collection';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_GENERATION_MODE: GenerationMode = 'all_in_one_reference';
const DEFAULT_RATIO = '16:9';
const DEFAULT_DURATION = 5;
const DEFAULT_RESOLUTION = '480p';
const DEFAULT_MODEL = 'dreamina-seedance-2-0-260128';

const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VALID_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];
const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];

// ============================================================================
// Duplicate submission guard
// ============================================================================

const recentSubmissions = new Map<string, number>(); // hash -> timestamp
const DEDUP_WINDOW_MS = 30_000; // 30 秒内相同 payload 视为重复提交

function computePayloadHash(payload: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').substring(0, 16);
}

// ============================================================================
// Reference Image Diagnostics (图片诊断)
// ============================================================================

interface RefImageDiagnostic {
  index: number;
  label: string;
  originalUrl: string;
  urlType: 'LOCAL' | 'BASE64' | 'HTTPS_EXTERNAL' | 'DATA_URI' | 'RELATIVE' | 'UNKNOWN';
  urlHost: string;
  isHttps: boolean;
  isPubliclyReachable: boolean;
  fileSize: number;
  mimeType: string;
  status: 'ok' | 'warning' | 'error';
  reason?: string;
}

function isPubliclyReachableUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0' || u.hostname === '[::1]') return false;
    if (u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.') || u.hostname.startsWith('127.')) return false;
    if (u.hostname.startsWith('169.254.') || u.hostname.endsWith('.local')) return false;
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

function getUrlHost(url: string): string {
  if (!url || url.startsWith('data:')) return 'inline-base64';
  if (url.startsWith('/')) return 'relative-path';
  try { return new URL(url).hostname; }
  catch { return 'unknown'; }
}

function getUrlType(url: string): RefImageDiagnostic['urlType'] {
  if (url.startsWith('data:')) return 'DATA_URI';
  if (url.startsWith('/')) return 'RELATIVE';
  if (url.startsWith('http://')) return 'HTTPS_EXTERNAL';
  if (url.startsWith('https://')) return 'HTTPS_EXTERNAL';
  if (url.startsWith('localhost') || url.includes('127.0.0.1')) return 'LOCAL';
  return 'UNKNOWN';
}

/**
 * 诊断所有参考图，返回诊断结果和建议
 */
async function diagnoseReferenceImages(
  urls: string[],
  base64Data: string[]
): Promise<{
  diagnostics: RefImageDiagnostic[];
  totalPayloadSizeKb: number;
  hasLocalUrls: boolean;
  hasNonPublicUrls: boolean;
}> {
  const diagnostics: RefImageDiagnostic[] = [];
  let totalPayloadSizeKb = 0;
  let hasLocalUrls = false;
  let hasNonPublicUrls = false;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const base64 = base64Data[i];
    const urlType = getUrlType(url);
    const urlHost = getUrlHost(url);
    const isHttps = url.startsWith('https://');
    const isPublic = isPubliclyReachableUrl(url);

    let fileSize = 0;
    let mimeType = 'unknown';

    if (base64 && base64.startsWith('data:')) {
      // 估算 base64 大小（base64 ≈ 4/3 原始大小）
      const base64Content = base64.split(',')[1] || '';
      fileSize = Math.round((base64Content.length * 3) / 4);
      mimeType = base64.match(/data:([^;]+)/)?.[1] || 'image/unknown';
      totalPayloadSizeKb += Math.round(fileSize / 1024);

      const diagnostic: RefImageDiagnostic = {
        index: i + 1,
        label: `图${i + 1}`,
        originalUrl: url,
        urlType,
        urlHost,
        isHttps,
        isPubliclyReachable: false, // base64 不需要网络访问
        fileSize,
        mimeType,
        status: 'ok',
      };

      if (fileSize > 10 * 1024 * 1024) { // > 10MB base64
        diagnostic.status = 'warning';
        diagnostic.reason = `base64 图片过大 (${(fileSize / 1024 / 1024).toFixed(1)}MB)，可能导致网关超时`;
      }

      diagnostics.push(diagnostic);
    } else if (url.startsWith('/uploads/')) {
      hasLocalUrls = true;
      hasNonPublicUrls = true;
      const filePath = path.join(process.cwd(), 'public', url);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        fileSize = stat.size;
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
        mimeType = mimeMap[ext] || 'image/jpeg';
      }
      diagnostics.push({
        index: i + 1,
        label: `图${i + 1}`,
        originalUrl: url,
        urlType: 'LOCAL',
        urlHost: 'localhost',
        isHttps: false,
        isPubliclyReachable: false,
        fileSize,
        mimeType,
        status: 'error',
        reason: '本地路径，Seedance 无法访问。将尝试转 base64，但大图可能超时。',
      });
    } else if (urlType === 'HTTPS_EXTERNAL') {
      if (!isPublic) {
        hasNonPublicUrls = true;
        diagnostics.push({
          index: i + 1,
          label: `图${i + 1}`,
          originalUrl: url,
          urlType,
          urlHost,
          isHttps,
          isPubliclyReachable: false,
          fileSize,
          mimeType,
          status: 'error',
          reason: `URL 不可公网访问 (${urlHost})`,
        });
      } else {
        diagnostics.push({
          index: i + 1,
          label: `图${i + 1}`,
          originalUrl: url,
          urlType,
          urlHost,
          isHttps,
          isPubliclyReachable: true,
          fileSize,
          mimeType,
          status: 'ok',
        });
      }
    } else {
      hasNonPublicUrls = true;
      diagnostics.push({
        index: i + 1,
        label: `图${i + 1}`,
        originalUrl: url,
        urlType,
        urlHost,
        isHttps,
        isPubliclyReachable: false,
        fileSize,
        mimeType,
        status: 'error',
        reason: `非标准 URL 类型: ${urlType}`,
      });
    }
  }

  return { diagnostics, totalPayloadSizeKb, hasLocalUrls, hasNonPublicUrls };
}

// ============================================================================
// Unified Reference Image Preparation (Step 3 of the generation flow)
// ============================================================================

interface PreparedReferenceImage {
  name: string;
  originalUrl: string; // 公网 HTTPS URL，Seedance 可直接下载
  providerAssetId?: string; // 官方 assetId（仅追踪记录，实际生成用 originalUrl）
  providerStatus?: string;
  sourceType: 'upload' | 'gallery' | 'external';
  order: number;
}

/**
 * 统一准备参考图：公网 URL + R2 上传 + asset/create 追踪
 *
 * 核心原则（绝对不可违反）：
 * 1. 视频生成接口只接受公网 HTTPS URL，不接受 base64，不接受本地路径
 * 2. 如果 original_url 是本地路径，必须上传 R2 得公网 URL，再继续
 * 3. asset/create 用于追踪记录，不改变视频生成传参
 * 4. asset/create 失败不影响生成（只记录失败，不阻断）
 * 5. R2 上传失败 → 报错阻断，不走 base64 fallback
 *
 * @param workspaceId 当前 workspace ID
 * @returns 准备好的参考图数组（全部公网 HTTPS URL）
 */
async function prepareReferenceImagesForSeedance(workspaceId: string): Promise<{
  preparedImages: PreparedReferenceImage[];
  prepareErrors: string[];
  summary: {
    total: number;
    publicUrl: number;
    r2Uploaded: number;
    withProviderAssetId: number;
    skipped: number;
    hasLocalPath: boolean;
    hasBase64: boolean;
  };
}> {
  console.log('\n========== Step 3: Prepare Reference Images ==========');

  // 1. 读取 workspace 所有图片
  const wsAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  const imageAssets = wsAssets.filter((wa) => wa.asset.type === 'image').slice(0, 9);
  const preparedImages: PreparedReferenceImage[] = [];
  const prepareErrors: string[] = [];

  let publicUrl = 0;
  let r2Uploaded = 0;
  let withProviderAssetId = 0;
  let skipped = 0;
  let hasLocalPath = false;
  let hasBase64 = false;

  for (let i = 0; i < imageAssets.length; i++) {
    const wa = imageAssets[i];
    const asset = wa.asset;
    const originalUrl = asset.original_url;
    const isPublicUrl = originalUrl.startsWith('https://') && !isLocalhostHost(originalUrl);
    const isR2Url = originalUrl.includes('.r2.') || originalUrl.includes('r2.dev') || originalUrl.includes('.toscdn.');
    const isExternalUrl = isPublicUrl && !isR2Url;
    const isLocalPath = originalUrl.startsWith('/');

    console.log(`  [${i + 1}] ${asset.file_name || 'untitled'} | ${getUrlHost(originalUrl)} | ${isPublicUrl ? '公网' : '非公网'} | ${isR2Url ? 'R2' : isExternalUrl ? '外部' : isLocalPath ? '本地路径' : '未知'}`);

    // === Case 1: 已是公网 HTTPS URL → 直接用 ===
    if (isPublicUrl) {
      publicUrl++;
      const sourceType: PreparedReferenceImage['sourceType'] = isR2Url ? 'upload' : 'external';
      preparedImages.push({
        name: asset.file_name || `图${i + 1}`,
        originalUrl,
        sourceType,
        order: i,
      });
      console.log(`       -> 直接使用公网 URL: ${getUrlHost(originalUrl)}`);
      continue;
    }

    // === Case 2: 本地路径 -> 必须上传 R2 得公网 URL ===
    if (isLocalPath) {
      hasLocalPath = true;
      console.log(`       ! 本地路径，强制上传 R2...`);

      const localFilePath = path.join(process.cwd(), 'public', originalUrl);
      if (!fs.existsSync(localFilePath)) {
        skipped++;
        prepareErrors.push(`[${i + 1}] 本地文件不存在: ${originalUrl}`);
        console.log(`       X 本地文件不存在，跳过`);
        continue;
      }

      const buffer = fs.readFileSync(localFilePath);
      const ext = path.extname(localFilePath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
      const mimeType = mimeMap[ext] || 'image/jpeg';

      // 上传 R2/TOS
      let r2PublicUrl: string | null = null;
      let uploadError: string | null = null;
      try {
        const { uploadPublicAsset } = await import('@/lib/assets/public-storage');
        const pubResult = await uploadPublicAsset(buffer, asset.file_name || `image.${ext}`, mimeType);
        r2PublicUrl = pubResult.publicUrl;
        console.log(`       OK R2 上传成功: ${getUrlHost(r2PublicUrl)}`);
      } catch (err) {
        uploadError = err instanceof Error ? err.message : String(err);
        console.log(`       X R2 上传失败: ${uploadError}`);
      }

      if (!r2PublicUrl) {
        skipped++;
        prepareErrors.push(`[${i + 1}] R2 上传失败: ${uploadError}，无法为 Seedance 准备参考图`);
        // 绝对不走 base64 fallback
        continue;
      }

      // 更新数据库 original_url 为公网 URL（下次不再重复上传）
      try {
        await prisma.asset.update({
          where: { id: asset.id },
          data: { original_url: r2PublicUrl },
        });
        console.log(`       OK DB original_url 已更新为 R2 URL`);
      } catch (err) {
        console.log(`       ! DB 更新失败（不影响生成）: ${err instanceof Error ? err.message : String(err)}`);
      }

      r2Uploaded++;
      preparedImages.push({
        name: asset.file_name || `图${i + 1}`,
        originalUrl: r2PublicUrl,
        sourceType: 'upload',
        order: i,
      });
      continue;
    }

    // === Case 3: 其他非公网 URL -> 跳过 ===
    skipped++;
    prepareErrors.push(`[${i + 1}] 非公网 URL 不可用: ${originalUrl}`);
    console.log(`       X 非公网 URL，跳过`);
  }

  console.log(`\n  准备完成: ${preparedImages.length} 张可用 | 公网 ${publicUrl} | R2上传 ${r2Uploaded} | 跳过 ${skipped}`);
  console.log(`  hasLocalPath: ${hasLocalPath} | hasBase64: ${hasBase64}`);
  if (prepareErrors.length > 0) {
    console.log(`  错误: ${prepareErrors.join('; ')}`);
  }
  console.log('================================================\n');

  return {
    preparedImages,
    prepareErrors,
    summary: { total: imageAssets.length, publicUrl, r2Uploaded, withProviderAssetId, skipped, hasLocalPath, hasBase64 },
  };
}

function isLocalhostHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.') || u.hostname.startsWith('172.');
  } catch { return false; }
}

// ============================================================================
// Image URL → base64 conversion
// ============================================================================

/**
 * 将本地 /uploads/assets/xxx 相对路径转换为 data:image/xxx;base64,... 格式
 * 这样 external provider 可以直接访问图片内容
 */
async function convertLocalImageToBase64(localPath: string): Promise<string | null> {
  if (!localPath.startsWith('/uploads/')) {
    // 已经是完整 URL 或 base64，原样返回
    return localPath;
  }

  const filePath = path.join(process.cwd(), 'public', localPath);
  if (!fs.existsSync(filePath)) {
    console.warn(`[ConvertBase64] File not found: ${filePath}`);
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  const mimeType = mimeTypeMap[ext] || 'image/jpeg';
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/**
 * 解析 referenceImageUrls 中的本地路径为 base64，同时返回调试信息
 */
async function resolveReferenceImageUrls(urls: string[]): Promise<{
  resolvedUrls: (string | null)[];
  debugInfo: Array<{ index: number; originalUrl: string; resolvedUrl: string | null; fileSize: number; mimeType: string }>;
}> {
  const resolvedUrls: (string | null)[] = [];
  const debugInfo: Array<{ index: number; originalUrl: string; resolvedUrl: string | null; fileSize: number; mimeType: string }> = [];

  for (const url of urls) {
    const resolved = await convertLocalImageToBase64(url);
    let fileSize = 0;
    let mimeType = 'unknown';

    if (url.startsWith('/uploads/')) {
      const filePath = path.join(process.cwd(), 'public', url);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        fileSize = stat.size;
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mimeTypeMap: Record<string, string> = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
          bmp: 'image/bmp',
        };
        mimeType = mimeTypeMap[ext] || 'image/jpeg';
      }
    }

    resolvedUrls.push(resolved);
    debugInfo.push({ index: resolvedUrls.length, originalUrl: url, resolvedUrl: resolved, fileSize, mimeType });
  }

  return { resolvedUrls, debugInfo };
}

// ============================================================================
// POST /api/video/create
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: '请先登录后再生成视频' },
        { status: 401 },
      );
    }
    if (user.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden', message: '该接口仅管理员可用，请使用任务创建接口生成视频' },
        { status: 403 },
      );
    }

    // ---- API Key Check ----
    if (!isApiKeyConfigured()) {
      return NextResponse.json(
        { error: 'API key not configured', message: '请在环境变量中配置 SEEDANCE_API_KEY' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const tabId = request.headers.get('x-tab-id') || 'default';

    // ---- Basic Validation ----
    if (!body.prompt || typeof body.prompt !== 'string') {
      return NextResponse.json(
        { error: 'Invalid input', message: 'prompt 是必填字段' },
        { status: 400 }
      );
    }

    // ---- Generation Mode ----
    const generationMode = (body.generation_mode as GenerationMode) || DEFAULT_GENERATION_MODE;
    if (!VALID_GENERATION_MODES.includes(generationMode)) {
      return NextResponse.json(
        { error: 'Invalid input', message: `generation_mode 必须是 ${VALID_GENERATION_MODES.join(', ')}` },
        { status: 400 }
      );
    }

    // ---- Ratio / Duration / Resolution ----
    const ratio = body.ratio || DEFAULT_RATIO;
    const duration = body.duration || DEFAULT_DURATION;
    const resolution = body.resolution || DEFAULT_RESOLUTION;
    if (!VALID_RATIOS.includes(ratio)) {
      return NextResponse.json({ error: 'Invalid input', message: `ratio 无效` }, { status: 400 });
    }
    if (!VALID_DURATIONS.includes(duration)) {
      return NextResponse.json({ error: 'Invalid input', message: `duration 必须是 4-15` }, { status: 400 });
    }
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      return NextResponse.json({ error: 'Invalid input', message: `resolution 无效` }, { status: 400 });
    }

    const seed = body.seed !== undefined ? body.seed : -1;
    const generateAudio = body.generate_audio !== undefined ? Boolean(body.generate_audio) : false;
    const returnLastFrame = body.return_last_frame !== undefined ? Boolean(body.return_last_frame) : false;
    const watermark = body.watermark !== undefined ? Boolean(body.watermark) : false;

    let project;
    try {
      project = await getProjectForGeneration(
        user,
        typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null,
      );
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ error: 'Forbidden', message: error.message }, { status: error.status });
      }
      throw error;
    }

    // ---- Workspace Resolution ----
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

    // ---- Reference Assets 元数据（已弃用，前端不再传 SeedanceAssetSelector 数据）----
    // 前端已简化为：上传 → workspace → 后台自动准备

    // ---- Workspace 素材自动注入 + 统一准备（核心链路）----
    // Step 3: 统一准备参考图：公网化 + R2 上传 + 脱敏 + 日志
    const { preparedImages, prepareErrors, summary: prepSummary } = await prepareReferenceImagesForSeedance(workspaceId);

    // 如果没有任何可用参考图（且用户未填 prompt），允许空图生成
    // 如果有图但全部跳过，说明参考图准备失败
    if (prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
      return NextResponse.json(
        {
          error: 'REFERENCE_IMAGE_NOT_PUBLIC',
          message: '参考图无法生成公网 URL，无法用于 Seedance 生成',
          details: {
            total: prepSummary.total,
            skipped: prepSummary.skipped,
            errors: prepareErrors,
          },
        },
        { status: 400 }
      );
    }

    let referenceImageUrls: string[] = [];
    let referenceVideoUrls: string[] = body.reference_video_urls ? [...body.reference_video_urls] : [];
    let referenceAudioUrls: string[] = body.reference_audio_urls ? [...body.reference_audio_urls] : [];
    let firstFrameUrl: string | undefined = body.first_frame_url;
    let lastFrameUrl: string | undefined = body.last_frame_url;
    let frameImageUrls: string[] = body.frame_image_urls ? [...body.frame_image_urls] : [];

    // 模式特定处理
    switch (generationMode) {
      case 'all_in_one_reference':
        // 从 prepareReferenceImagesForSeedance 得到的公网 URL 数组
        referenceImageUrls = preparedImages.map((img) => img.originalUrl);
        referenceImageUrls = referenceImageUrls.slice(0, 9);
        referenceVideoUrls = referenceVideoUrls.slice(0, 3);
        referenceAudioUrls = referenceAudioUrls.slice(0, 3);
        break;

      case 'first_last_frame':
        firstFrameUrl = firstFrameUrl || body.first_frame_url;
        lastFrameUrl = lastFrameUrl || body.last_frame_url;
        if (!firstFrameUrl) {
          // 尝试从准备好的图片取第一张
          firstFrameUrl = preparedImages[0]?.originalUrl;
        }
        if (!firstFrameUrl) {
          return NextResponse.json(
            { error: 'Invalid input', message: '首尾帧模式必须提供首帧图片（请上传或选择首帧）' },
            { status: 400 }
          );
        }
        break;

      case 'smart_multi_frame':
        if (frameImageUrls.length === 0) {
          frameImageUrls = preparedImages.map((img) => img.originalUrl);
        }
        if (frameImageUrls.length < 2) {
          return NextResponse.json(
            { error: 'Invalid input', message: '智能多帧模式至少需要 2 张图片' },
            { status: 400 }
          );
        }
        break;
    }

    // ---- Duplicate Submission Guard ----
    // 包含 referenceImageUrls，确保相同 prompt + 不同图片不被错误拦截
    const dedupPayload = {
      prompt: body.prompt,
      generation_mode: generationMode,
      ratio,
      duration,
      resolution,
      seed,
      referenceImageUrls,
    };
    const payloadHash = computePayloadHash(dedupPayload);
    const lastSubmit = recentSubmissions.get(payloadHash);
    if (lastSubmit && Date.now() - lastSubmit < DEDUP_WINDOW_MS) {
      return NextResponse.json(
        { error: 'Duplicate submission', message: '30秒内请勿重复提交相同参数的任务' },
        { status: 429 }
      );
    }
    recentSubmissions.set(payloadHash, Date.now());

    // ---- Prompt 图号验证 ----
    const validation = await validatePromptReferences(body.prompt, workspaceId);
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: 'Prompt reference error',
          message: `prompt 中引用的图号不存在: ${validation.missing.join(', ')}`,
          details: { missing: validation.missing },
        },
        { status: 400 }
      );
    }

    // ---- Render Prompt (图号 -> URL) ----
    const { promptRendered, assetMapping } = await renderPromptWithAssets(
      body.prompt,
      workspaceId,
      generationMode
    );

    // ---- Reference Image Diagnostics ----
    const refDiag = await diagnoseReferenceImages(referenceImageUrls, []);
    console.log('\n========== Reference Image Diagnostics ==========');
    console.log(`Total: ${refDiag.diagnostics.length} images, ~${refDiag.totalPayloadSizeKb}KB base64 estimate`);
    console.log(`Has local URLs: ${refDiag.hasLocalUrls}`);
    console.log(`Has non-public URLs: ${refDiag.hasNonPublicUrls}`);
    for (const d of refDiag.diagnostics) {
      const sizeKb = d.fileSize > 0 ? `${(d.fileSize / 1024).toFixed(0)}KB` : 'unknown';
      console.log(`  [${d.index}] ${d.label}: ${d.urlType} | ${d.urlHost} | ${d.mimeType} | ${sizeKb} | ${d.status}${d.reason ? ` | ⚠ ${d.reason}` : ''}`);
    }
    console.log('================================================\n');

    // ---- Resolve local image URLs → base64 (for external provider access) ----
    // Build reference_images_debug for snapshot/DB storage
    const referenceImagesDebug: Array<{
      index: number;
      label: string;
      originalUrl: string;
      resolvedUrl: string | null;
      fileSize: number;
      mimeType: string;
      status: 'resolved' | 'skipped' | 'failed';
    }> = [];

    // Resolve reference images
    let referenceImageBase64Data: string[] = [];
    for (let i = 0; i < referenceImageUrls.length; i++) {
      const url = referenceImageUrls[i];
      const base64 = await convertLocalImageToBase64(url);
      const resolved = base64 ?? url;
      let fileSize = 0;
      let mimeType = 'unknown';

      if (url.startsWith('/uploads/')) {
        const filePath = path.join(process.cwd(), 'public', url);
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          fileSize = stat.size;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mimeTypeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
          };
          mimeType = mimeTypeMap[ext] || 'image/jpeg';
        }
      }

      if (base64) {
        referenceImageBase64Data.push(base64);
        referenceImagesDebug.push({
          index: i + 1,
          label: `图${i + 1}`,
          originalUrl: url,
          resolvedUrl: base64.slice(0, 50) + '...(base64)',
          fileSize,
          mimeType,
          status: 'resolved',
        });
      } else {
        referenceImagesDebug.push({
          index: i + 1,
          label: `图${i + 1}`,
          originalUrl: url,
          resolvedUrl: url,
          fileSize,
          mimeType,
          status: 'failed',
        });
      }
    }

    // Resolve first_frame
    let firstFrameBase64: string | undefined;
    if (firstFrameUrl) {
      firstFrameBase64 = (await convertLocalImageToBase64(firstFrameUrl)) ?? undefined;
    }

    // Resolve last_frame
    let lastFrameBase64: string | undefined;
    if (lastFrameUrl) {
      lastFrameBase64 = (await convertLocalImageToBase64(lastFrameUrl)) ?? undefined;
    }

    // Resolve frame images
    let frameImageBase64Data: string[] = [];
    for (const url of frameImageUrls) {
      const base64 = await convertLocalImageToBase64(url);
      if (base64) frameImageBase64Data.push(base64);
    }

    // ---- Build Provider Input ----
    const input: CreateVideoInput = {
      prompt: promptRendered,
      generation_mode: generationMode,
      ratio: ratio as CreateVideoInput['ratio'],
      duration: duration as CreateVideoInput['duration'],
      resolution: resolution as CreateVideoInput['resolution'],
      seed,
      generate_audio: generateAudio,
      return_last_frame: returnLastFrame,
      watermark,
      // local URLs (for snapshot record)
      reference_image_urls: referenceImageUrls,
      reference_video_urls: referenceVideoUrls,
      reference_audio_urls: referenceAudioUrls,
      first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl,
      frame_image_urls: frameImageUrls,
      // base64 data (for provider payload)
      reference_image_base64_data: referenceImageBase64Data,
      first_frame_base64_data: firstFrameBase64,
      last_frame_base64_data: lastFrameBase64,
      frame_image_base64_data: frameImageBase64Data,
      callback_url: body.callback_url,
      execution_expires_after: body.execution_expires_after,
    };

    // Build final content array (uses base64 if available)
    const content = buildContentArray(input);

    // ---- Resolve Mode Label ----
    const resolvedMode = referenceImageBase64Data.length > 0 || firstFrameBase64 || frameImageBase64Data.length > 0
      ? (generationMode === 'all_in_one_reference' && referenceImageUrls.length === 0 ? 'text_to_video' : generationMode)
      : 'text_to_video';

    // ---- Build provider_payload for snapshot (without base64, only metadata) ----
    // 新的 payload summary：明确 no localhost, no base64, no local path
    const payloadReferenceHosts = Array.from(new Set(preparedImages.map((img) => getUrlHost(img.originalUrl))));
    const hasLocalPathInPayload = preparedImages.some((img) => img.originalUrl.startsWith('/'));
    const hasBase64InPayload = preparedImages.some((img) => img.originalUrl.startsWith('data:'));

    const providerPayloadDebug = {
      model: 'dreamina-seedance-2-0-260128',
      generation_mode: generationMode,
      resolved_mode: resolvedMode,
      prompt: promptRendered,
      content_item_count: content.length,
      // 新的参考图 summary
      referenceFieldName: 'content[].image_url.url',
      usingField: 'originalUrl (公网 HTTPS URL)',
      referenceCount: preparedImages.length,
      referenceHosts: payloadReferenceHosts,
      referencePrepareSummary: prepSummary,
      // 严格校验：禁止出现这些
      NO_LOCALHOST: !payloadReferenceHosts.some((h) => h.includes('localhost') || h.includes('127.0.0.1')),
      NO_LOCAL_PATH: !hasLocalPathInPayload,
      NO_BASE64: !hasBase64InPayload,
      prepareErrors,
      // Full content array (truncated base64 for readability)
      content: content.map((item) => {
        if (item.type === 'image_url' && item.image_url?.url.startsWith('data:')) {
          return { type: item.type, role: item.role, image_url: { url: item.image_url.url.slice(0, 60) + '...(base64 data)' } };
        }
        return item;
      }),
    };

    // ---- Create Snapshot ----
    const snapshot = await createTaskSnapshot({
      workspaceId,
      generationMode,
      promptRaw: body.prompt,
      input,
      providerPayloadJson: JSON.stringify(providerPayloadDebug, null, 2),
    });

    // ---- Create Local Task ----
    const localTask = await prisma.videoTask.create({
      data: {
        provider: 'seedance',
        model: DEFAULT_MODEL,
        generation_mode: generationMode,
        prompt: body.prompt,
        ratio,
        duration,
        resolution,
        seed,
        generate_audio: generateAudio,
        return_last_frame: returnLastFrame,
        watermark,
        reference_image_urls: referenceImageUrls.length > 0 ? JSON.stringify(referenceImageUrls) : null,
        reference_video_urls: referenceVideoUrls.length > 0 ? JSON.stringify(referenceVideoUrls) : null,
        reference_audio_urls: referenceAudioUrls.length > 0 ? JSON.stringify(referenceAudioUrls) : null,
        first_frame_url: firstFrameUrl || null,
        last_frame_url: lastFrameUrl || null,
        frame_image_urls: frameImageUrls.length > 0 ? JSON.stringify(frameImageUrls) : null,
        callback_url: body.callback_url || null,
        execution_expires_after: body.execution_expires_after || null,
        workspace_id: workspaceId,
        snapshot_id: snapshot.id,
        user_id: user.id,
        owner_user_id: user.id,
        project_id: project.id,
        visibility: project.type === 'personal' ? 'private' : 'project',
        billing_scope: 'user',
        billing_account_id: user.id,
        params_json: JSON.stringify({
          ratio, duration, resolution, seed,
          generateAudio, returnLastFrame, watermark,
          preparedImages: preparedImages.map((img) => ({
            name: img.name,
            originalUrl: img.originalUrl,
            urlHost: getUrlHost(img.originalUrl),
            providerAssetId: img.providerAssetId,
            sourceType: img.sourceType,
          })),
          prepSummary,
          referenceImageDiagnostics: refDiag.diagnostics.map((d) => ({
            index: d.index, label: d.label, urlType: d.urlType,
            urlHost: d.urlHost, fileSize: d.fileSize, status: d.status, reason: d.reason,
          })),
          base64EstimateKb: refDiag.totalPayloadSizeKb,
        }),
        // 新增：参考图调试信息（包含 base64 解析状态）
        reference_images_json: JSON.stringify(referenceImagesDebug, null, 2),
        // 新增：最终 provider payload（完整 content 数组）
        provider_payload_json: JSON.stringify(providerPayloadDebug, null, 2),
        local_status: 'submitted',
      },
    });

    // ---- Step1: Call Provider API ----
    try {
      input.clientRequestId = localTask.id;
      input.client_request_id = localTask.id;
      await prisma.videoTask.update({
        where: { id: localTask.id },
        data: { provider_client_request_id: localTask.id },
      });

      const providerResult = await createVideoTask(input);

      // 更新本地任务，保存 provider_task_id 和 raw response
      const updatedTask = await prisma.videoTask.update({
        where: { id: localTask.id },
        data: {
          provider_task_id: providerResult.provider_task_id,
          raw_create_response: JSON.stringify(providerResult.raw),
        },
      });

      return NextResponse.json({
        id: updatedTask.id,
        provider_task_id: updatedTask.provider_task_id,
        status: updatedTask.local_status,
        created_at: updatedTask.created_at,
        generation_mode: updatedTask.generation_mode,
        workspace_id: workspaceId,
        project_id: project.id,
        snapshot_id: snapshot.id,
        prompt_rendered: promptRendered,
        asset_mapping: assetMapping,
      });
    } catch (apiError) {
      await prisma.videoTask.update({
        where: { id: localTask.id },
        data: {
          local_status: 'failed',
          error_message: apiError instanceof Error ? apiError.message : 'Unknown error',
        },
      });

      // 从错误中提取 provider context
      const errWithCtx = apiError as Error & { providerContext?: unknown };
      const providerCtx = errWithCtx.providerContext as {
        httpStatus?: number;
        source?: string;
        code?: string;
        requestId?: string;
        payloadSummary?: unknown;
      } | undefined;

      // 构造友好的中文错误消息
      const statusCode = providerCtx?.httpStatus;
      const errMsg = apiError instanceof Error ? apiError.message : 'Unknown error';

      let userMessage = '创建任务失败';
      if (statusCode === 524) {
        userMessage = refDiag.hasLocalUrls
          ? 'Seedance 创建任务超时。参考图中包含本地图片（需转 base64），大图可能导致网关超时。建议：重新上传为公网可访问的图片，或使用更小的图片。'
          : 'Seedance 服务响应超时，可能因参考图无法被正常下载。';
      } else if (statusCode) {
        userMessage = `创建任务失败（HTTP ${statusCode}）: ${errMsg}`;
      }

      return NextResponse.json(
        {
          error: 'API call failed',
          message: userMessage,
          snapshot_id: snapshot.id,
          // 结构化调试信息
          _debug: {
            providerContext: providerCtx ? {
              httpStatus: providerCtx.httpStatus,
              source: providerCtx.source,
              code: providerCtx.code,
              requestId: providerCtx.requestId,
              payloadSummary: providerCtx.payloadSummary,
            } : undefined,
            referenceImageDiagnostics: refDiag.diagnostics.map((d) => ({
              index: d.index,
              label: d.label,
              urlType: d.urlType,
              urlHost: d.urlHost,
              mimeType: d.mimeType,
              fileSizeBytes: d.fileSize,
              status: d.status,
              reason: d.reason,
            })),
            base64EstimateKb: refDiag.totalPayloadSizeKb,
            hasLocalUrls: refDiag.hasLocalUrls,
            hasNonPublicUrls: refDiag.hasNonPublicUrls,
            providerReferenceField: 'reference_image_base64_data (local) / reference_image_urls (external)',
          },
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[CreateVideo] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
