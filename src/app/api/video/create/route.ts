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
const VALID_RESOLUTIONS = ['480p', '720p'];
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

    // ---- Workspace Resolution ----
    const { id: workspaceId } = await getOrCreateWorkspace(tabId);

    // ---- Reference Assets 元数据（Seedance 资产完整信息）----
    // 前端从 Seedance 资产选择器传来，保存到 params_json 用于任务详情回看
    interface ReferenceAssetMeta {
      localAssetId: string;
      provider: string;
      providerAssetId: string;
      name: string;
      originalUrl: string;
      providerPreviewUrl?: string | null;
      providerStatus?: string | null;
      order: number;
    }
    const referenceAssets: ReferenceAssetMeta[] = Array.isArray(body.reference_assets)
      ? body.reference_assets.filter((a: ReferenceAssetMeta) => a && a.localAssetId && a.originalUrl)
      : [];

    // ---- Workspace 素材自动注入 ----
    let referenceImageUrls: string[] = body.reference_image_urls ? [...body.reference_image_urls] : [];
    let referenceVideoUrls: string[] = body.reference_video_urls ? [...body.reference_video_urls] : [];
    let referenceAudioUrls: string[] = body.reference_audio_urls ? [...body.reference_audio_urls] : [];
    let firstFrameUrl: string | undefined = body.first_frame_url;
    let lastFrameUrl: string | undefined = body.last_frame_url;
    let frameImageUrls: string[] = body.frame_image_urls ? [...body.frame_image_urls] : [];

    // 模式特定处理
    switch (generationMode) {
      case 'all_in_one_reference':
        // 自动从 workspace 注入图片（如果前端没有传）
        if (referenceImageUrls.length === 0) {
          const wsAssets = await prisma.workspaceAsset.findMany({
            where: { workspace_id: workspaceId },
            include: { asset: true },
            orderBy: { sort_order: 'asc' },
          });
          referenceImageUrls = wsAssets
            .filter((wa) => wa.asset.type === 'image')
            .slice(0, 9)
            .map((wa) => wa.asset.original_url);
        }
        referenceImageUrls = referenceImageUrls.slice(0, 9);
        referenceVideoUrls = referenceVideoUrls.slice(0, 3);
        referenceAudioUrls = referenceAudioUrls.slice(0, 3);
        break;

      case 'first_last_frame':
        firstFrameUrl = firstFrameUrl || body.first_frame_url;
        lastFrameUrl = lastFrameUrl || body.last_frame_url;
        if (!firstFrameUrl) {
          // 尝试从 workspace 取第一张图
          const firstAssets = await prisma.workspaceAsset.findFirst({
            where: { workspace_id: workspaceId },
            include: { asset: true },
            orderBy: { sort_order: 'asc' },
          });
          if (firstAssets?.asset.type === 'image') {
            firstFrameUrl = firstAssets.asset.original_url;
          }
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
          const frameAssets = await prisma.workspaceAsset.findMany({
            where: { workspace_id: workspaceId },
            include: { asset: true },
            orderBy: { sort_order: 'asc' },
          });
          frameImageUrls = frameAssets
            .filter((wa) => wa.asset.type === 'image')
            .slice(0, 9)
            .map((wa) => wa.asset.original_url);
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
    const providerPayloadDebug = {
      model: 'dreamina-seedance-2-0-260128',
      generation_mode: generationMode,
      resolved_mode: resolvedMode,
      prompt: promptRendered,
      content_item_count: content.length,
      reference_images_count: referenceImageBase64Data.length,
      reference_images_debug: referenceImagesDebug,
      first_frame_base64_status: firstFrameBase64 ? 'resolved' : 'none',
      last_frame_base64_status: lastFrameBase64 ? 'resolved' : 'none',
      ratio,
      duration,
      resolution,
      seed,
      generate_audio: generateAudio,
      watermark,
      // Full content array (with truncated base64 for readability)
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
        params_json: JSON.stringify({
          ratio, duration, resolution, seed,
          generateAudio, returnLastFrame, watermark,
          referenceAssets,
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
