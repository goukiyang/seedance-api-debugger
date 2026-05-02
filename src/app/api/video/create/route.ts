/**
 * POST /api/video/create
 *
 * 功能：
 * - workspace 素材自动注入
 * - prompt 图号验证
 * - 参考图统一处理（workspace 素材 + Seedance 外部资产 → reference_image_urls）
 * - 统一 base64 转换（解决本地 URL 问题）
 * - 任务快照创建
 * - 重复提交保护（payload hash）
 * - 详细脱敏调试日志
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { createVideoTask, isApiKeyConfigured, type ProviderErrorContext } from '@/lib/provider/jimeng';
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

const recentSubmissions = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

function computePayloadHash(payload: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').substring(0, 16);
}

// ============================================================================
// Image URL → base64 conversion
// ============================================================================

/**
 * 将本地 /uploads/assets/xxx 相对路径转换为 data:image/xxx;base64,... 格式
 * 对于已是 https:// 或 data: 的 URL，原样返回
 */
async function convertLocalImageToBase64(localPath: string): Promise<string | null> {
  if (!localPath.startsWith('/uploads/')) {
    return localPath; // 已是完整 URL 或 base64，原样返回
  }

  const filePath = path.join(process.cwd(), 'public', localPath);
  if (!fs.existsSync(filePath)) {
    console.warn(`[ConvertBase64] File not found: ${filePath}`);
    return null;
  }

  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  };
  const mimeType = mimeTypeMap[ext] || 'image/jpeg';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

// ============================================================================
// POST /api/video/create
// ============================================================================

export async function POST(request: NextRequest) {
  const requestIdLocal = crypto.randomUUID().slice(0, 8);

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

    console.log(`\n========== [${requestIdLocal}] Create Video Task Request ==========`);
    console.log(`Generation mode:  ${body.generation_mode || DEFAULT_GENERATION_MODE}`);
    console.log(`Prompt length:   ${body.prompt?.length ?? 0}`);
    console.log(`Ratio:           ${body.ratio || DEFAULT_RATIO}`);
    console.log(`Duration:        ${body.duration || DEFAULT_DURATION}s`);
    console.log(`Resolution:      ${body.resolution || DEFAULT_RESOLUTION}`);
    console.log(`Seed:            ${body.seed ?? 'random'}`);
    console.log(`Tab ID:          ${tabId}`);

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

    // ---- Reference Assets（元数据：Seedance 外部资产）----
    // 前端传来，保存到 params_json 用于任务详情回看
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

    console.log(`\n--- Reference Images ---`);
    console.log(`  Workspace reference_image_urls:  ${(body.reference_image_urls ?? []).length} (from frontend)`);
    console.log(`  Seedance external assets (referenceAssets): ${referenceAssets.length}`);
    console.log(`  Workspace assets will be auto-injected if frontend didn't pass them`);

    // ---- Workspace 素材自动注入 ----
    // 模式特定处理
    let referenceImageUrls: string[] = body.reference_image_urls ? [...body.reference_image_urls] : [];
    let referenceVideoUrls: string[] = body.reference_video_urls ? [...body.reference_video_urls] : [];
    let referenceAudioUrls: string[] = body.reference_audio_urls ? [...body.reference_audio_urls] : [];
    let firstFrameUrl: string | undefined = body.first_frame_url;
    let lastFrameUrl: string | undefined = body.last_frame_url;
    let frameImageUrls: string[] = body.frame_image_urls ? [...body.frame_image_urls] : [];

    switch (generationMode) {
      case 'all_in_one_reference': {
        // 自动从 workspace 注入（如果前端没有传）
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
          console.log(`  Auto-injected from workspace:  ${referenceImageUrls.length} images`);
        }
        // 如果有 referenceAssets（外部资产），也加入 referenceImageUrls
        // 注意：external assets 的 originalUrl 可能是 https:// 或其他公网 URL
        if (referenceAssets.length > 0) {
          const externalUrls = referenceAssets
            .filter((a) => a.originalUrl)
            .sort((a, b) => a.order - b.order)
            .map((a) => a.originalUrl);
          // 合并去重（external URLs 不在 workspace 中，可能有重复）
          const existing = new Set(referenceImageUrls);
          for (const url of externalUrls) {
            if (!existing.has(url)) {
              referenceImageUrls.push(url);
            }
          }
          console.log(`  External assets added:          ${externalUrls.length} (total now: ${referenceImageUrls.length})`);
        }
        referenceImageUrls = referenceImageUrls.slice(0, 9);
        referenceVideoUrls = referenceVideoUrls.slice(0, 3);
        referenceAudioUrls = referenceAudioUrls.slice(0, 3);
        break;
      }

      case 'first_last_frame':
        firstFrameUrl = firstFrameUrl || body.first_frame_url;
        if (!firstFrameUrl) {
          const firstAssets = await prisma.workspaceAsset.findFirst({
            where: { workspace_id: workspaceId },
            include: { asset: true },
            orderBy: { sort_order: 'asc' },
          });
          if (firstAssets?.asset.type === 'image') {
            firstFrameUrl = firstAssets.asset.original_url;
            console.log(`  Auto-injected first frame from workspace: ${firstFrameUrl}`);
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
          console.log(`  Auto-injected from workspace (multi-frame): ${frameImageUrls.length} images`);
        }
        if (frameImageUrls.length < 2) {
          return NextResponse.json(
            { error: 'Invalid input', message: '智能多帧模式至少需要 2 张图片' },
            { status: 400 }
          );
        }
        break;
    }

    // ---- Reference image URL 调试信息 ----
    console.log(`\n--- Final Reference Image URLs (${referenceImageUrls.length}) ---`);
    for (let i = 0; i < referenceImageUrls.length; i++) {
      const url = referenceImageUrls[i];
      const isLocal = url.startsWith('/uploads/');
      const isDataUrl = url.startsWith('data:');
      const isHttps = url.startsWith('https://');
      let host = 'local-file';
      if (!isLocal && !isDataUrl) {
        try { host = new URL(url).hostname; } catch {}
      }
      console.log(`  [${i + 1}] ${isLocal ? 'LOCAL' : isDataUrl ? 'BASE64' : 'HTTPS'} host=${host} url=${isLocal ? url : url.slice(0, 80) + (url.length > 80 ? '...' : '')}`);
    }

    // ---- Reference Assets 调试信息 ----
    if (referenceAssets.length > 0) {
      console.log(`\n--- Reference Assets (Seedance external, ${referenceAssets.length}) ---`);
      for (const asset of referenceAssets) {
        let host = 'unknown';
        try { host = new URL(asset.originalUrl).hostname; } catch {}
        console.log(`  id=${asset.localAssetId} providerId=${asset.providerAssetId} status=${asset.providerStatus ?? 'N/A'} host=${host}`);
      }
    }

    // ---- Duplicate Submission Guard ----
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

    // ---- Resolve: local URLs → base64 (for external provider access) ----
    const referenceImagesDebug: Array<{
      index: number;
      label: string;
      originalUrl: string;
      resolvedUrl: string | null;
      fileSize: number;
      mimeType: string;
      status: 'resolved' | 'skipped' | 'failed';
    }> = [];

    let referenceImageBase64Data: string[] = [];
    for (let i = 0; i < referenceImageUrls.length; i++) {
      const url = referenceImageUrls[i];
      const base64 = await convertLocalImageToBase64(url);
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
        // 非本地路径（已是 https URL），不转换
        referenceImagesDebug.push({
          index: i + 1,
          label: `图${i + 1}`,
          originalUrl: url,
          resolvedUrl: url.startsWith('data:') ? url.slice(0, 50) + '...(base64)' : url,
          fileSize,
          mimeType,
          status: url.startsWith('/uploads/') ? 'failed' : 'skipped',
        });
      }
    }

    let firstFrameBase64: string | undefined;
    if (firstFrameUrl) {
      firstFrameBase64 = (await convertLocalImageToBase64(firstFrameUrl)) ?? undefined;
    }
    let lastFrameBase64: string | undefined;
    if (lastFrameUrl) {
      lastFrameBase64 = (await convertLocalImageToBase64(lastFrameUrl)) ?? undefined;
    }
    let frameImageBase64Data: string[] = [];
    for (const url of frameImageUrls) {
      const base64 = await convertLocalImageToBase64(url);
      if (base64) frameImageBase64Data.push(base64);
    }

    // ---- Reference image resolve 汇总 ----
    const resolvedCount = referenceImagesDebug.filter((d) => d.status === 'resolved').length;
    const failedCount = referenceImagesDebug.filter((d) => d.status === 'failed').length;
    const skippedCount = referenceImagesDebug.filter((d) => d.status === 'skipped').length;
    const totalBase64Size = referenceImageBase64Data.reduce(
      (acc, b64) => acc + Buffer.byteLength(b64, 'utf8'), 0
    );
    console.log(`\n--- Reference Image Resolve Summary ---`);
    console.log(`  Resolved (local→base64): ${resolvedCount}`);
    console.log(`  Skipped (already https):  ${skippedCount}`);
    console.log(`  Failed (file not found):  ${failedCount}`);
    console.log(`  Total base64 size:        ~${Math.round(totalBase64Size / 1024)} KB`);
    console.log(`  Sent to provider:          ${referenceImageBase64Data.length} images`);

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
      reference_image_urls: referenceImageUrls,
      reference_video_urls: referenceVideoUrls,
      reference_audio_urls: referenceAudioUrls,
      first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl,
      frame_image_urls: frameImageUrls,
      reference_image_base64_data: referenceImageBase64Data,
      first_frame_base64_data: firstFrameBase64,
      last_frame_base64_data: lastFrameBase64,
      frame_image_base64_data: frameImageBase64Data,
      callback_url: body.callback_url,
      execution_expires_after: body.execution_expires_after,
    };

    const content = buildContentArray(input);

    // ---- Resolve Mode Label ----
    const resolvedMode = referenceImageBase64Data.length > 0 || firstFrameBase64 || frameImageBase64Data.length > 0
      ? (generationMode === 'all_in_one_reference' && referenceImageUrls.length === 0 ? 'text_to_video' : generationMode)
      : 'text_to_video';

    // ---- Build provider_payload snapshot (truncated base64) ----
    const providerPayloadDebug = {
      model: DEFAULT_MODEL,
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
      content: content.map((item) => {
        if (item.type === 'image_url' && item.image_url?.url.startsWith('data:')) {
          return { type: item.type, role: item.role, image_url: { url: item.image_url.url.slice(0, 60) + '...(base64)' } };
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
          ratio,
          duration,
          resolution,
          seed,
          generateAudio,
          returnLastFrame,
          watermark,
          referenceAssets,
          // 明确标注最终使用的参考图 URL
          finalReferenceImageUrls: referenceImageUrls,
        }),
        reference_images_json: JSON.stringify(referenceImagesDebug, null, 2),
        provider_payload_json: JSON.stringify(providerPayloadDebug, null, 2),
        local_status: 'submitted',
      },
    });

    console.log(`\n[${requestIdLocal}] Local task created: ${localTask.id}`);
    console.log(`[${requestIdLocal}] Calling provider createVideoTask()...`);
    console.log('==============================================================\n');

    // ---- Step1: Call Provider API ----
    try {
      const providerResult = await createVideoTask(input);

      await prisma.videoTask.update({
        where: { id: localTask.id },
        data: {
          provider_task_id: providerResult.provider_task_id,
          raw_create_response: JSON.stringify(providerResult.raw),
        },
      });

      return NextResponse.json({
        id: localTask.id,
        provider_task_id: providerResult.provider_task_id,
        status: 'submitted',
        created_at: localTask.created_at,
        generation_mode: localTask.generation_mode,
        workspace_id: workspaceId,
        snapshot_id: snapshot.id,
        prompt_rendered: promptRendered,
        asset_mapping: assetMapping,
      });
    } catch (apiError: unknown) {
      // 提取 provider 错误上下文
      const providerCtx = (apiError as Error & { providerContext?: ProviderErrorContext })?.providerContext;

      await prisma.videoTask.update({
        where: { id: localTask.id },
        data: {
          local_status: 'failed',
          error_message: apiError instanceof Error ? apiError.message : 'Unknown error',
        },
      });

      // 错误响应中附加脱敏的调试信息
      const errorDetails: Record<string, unknown> = {
        requestIdLocal,
        snapshot_id: snapshot.id,
        providerContext: providerCtx ? {
          httpStatus: providerCtx.httpStatus,
          source: providerCtx.source,
          code: providerCtx.code,
          providerMessage: providerCtx.providerMessage,
          requestId: providerCtx.requestId,
          payloadSummary: providerCtx.payloadSummary,
        } : undefined,
      };

      console.error(`\n[${requestIdLocal}] ❌ Provider API failed: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
      if (providerCtx) {
        console.error(`  Source:    ${providerCtx.source}`);
        console.error(`  HTTP:      ${providerCtx.httpStatus}`);
        console.error(`  Code:      ${providerCtx.code}`);
        console.error(`  RequestId: ${providerCtx.requestId ?? 'none'}`);
        console.error(`  Message:   ${providerCtx.providerMessage ?? 'none'}`);
        console.error(`  Payload:   ${providerCtx.payloadSummary?.referenceImageCount} images, ~${providerCtx.payloadSummary?.totalPayloadSizeKb}KB`);
      }
      console.error('==============================================================\n');

      return NextResponse.json(
        {
          error: 'API call failed',
          // 提取友好的用户消息
          message: providerCtx
            ? `${providerCtx.source === 'provider_gateway_timeout' ? 'Seedance 服务响应超时' : '创建任务失败'}（${providerCtx.code}）`
            : (apiError instanceof Error ? apiError.message : 'Unknown error'),
          // 详细调试信息
          _debug: errorDetails,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error(`\n[${requestIdLocal}] ❌ Internal error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('==============================================================\n');
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
