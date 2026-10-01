import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { assertCanUseReferenceImage, canUseDirectAsset, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { seedanceReferenceMediaCapabilities } from '@/lib/provider/reference-media-policy';

export const dynamic = 'force-dynamic';

const VALID_ASSET_ROLES = new Set([
  'reference_image',
  'first_frame',
  'last_frame',
  'reference_video',
  'reference_audio',
]);
const VALID_GENERATION_MODES = new Set(['all_in_one_reference', 'first_last_frame', 'smart_multi_frame']);
const VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const VALID_RESOLUTIONS = new Set(['480p', '720p', '1080p']);

type AssetRole = 'reference_image' | 'first_frame' | 'last_frame' | 'reference_video' | 'reference_audio';

type ReuseCandidate = {
  assetId?: string;
  url?: string;
  role: AssetRole;
  referenceImageId?: string;
  roleNeedsWarning?: boolean;
};

type SnapshotContentItem = {
  type?: unknown;
  role?: unknown;
  image_url?: { url?: unknown };
  video_url?: { url?: unknown };
  audio_url?: { url?: unknown };
};

type ReuseAsset = {
  id: string;
  type: string;
  original_url: string;
  status: string;
  reference_images: Array<{ id: string }>;
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function parseParams(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseSnapshotAssetIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const ordered = Object.entries(parsed as Record<string, unknown>)
      .flatMap(([key, assetId]) => {
        const match = /^图(\d+)$/.exec(key);
        return match && typeof assetId === 'string' && assetId.trim()
          ? [{ order: Number(match[1]), assetId: assetId.trim() }]
          : [];
      })
      .sort((a, b) => a.order - b.order)
      .map((item) => item.assetId);
    return uniquePreserveOrder(ordered);
  } catch {
    return [];
  }
}

function parseSnapshotContent(value: string | null | undefined): SnapshotContentItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is SnapshotContentItem => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [];
  } catch {
    return [];
  }
}

function contentUrl(item: SnapshotContentItem): string | null {
  const value = item.type === 'image_url'
    ? item.image_url?.url
    : item.type === 'video_url'
      ? item.video_url?.url
      : item.type === 'audio_url'
        ? item.audio_url?.url
        : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inferredRole(type: string): AssetRole | null {
  if (type === 'image') return 'reference_image';
  if (type === 'video') return 'reference_video';
  if (type === 'audio') return 'reference_audio';
  return null;
}

function roleForType(role: unknown, type: string): AssetRole | null {
  const fallback = inferredRole(type);
  if (typeof role !== 'string' || !VALID_ASSET_ROLES.has(role)) return fallback;
  if (type === 'image' && ['reference_image', 'first_frame', 'last_frame'].includes(role)) return role as AssetRole;
  if (type === 'video' && role === 'reference_video') return role;
  if (type === 'audio' && role === 'reference_audio') return role;
  return fallback;
}

function valueFromParams(params: Record<string, unknown>, camel: string, snake: string) {
  return params[camel] ?? params[snake];
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function originalParameter(
  taskParams: Record<string, unknown>,
  requestedParams: Record<string, unknown>,
  camel: string,
  snake: string,
  taskValue: unknown,
) {
  return requestedParams[camel]
    ?? requestedParams[snake]
    ?? requestedParams[`requested_${camel}`]
    ?? requestedParams[`requested_${snake}`]
    ?? taskParams[`requested_${camel}`]
    ?? taskParams[`requested_${snake}`]
    ?? taskParams[camel]
    ?? taskParams[snake]
    ?? taskValue;
}

function hasSnapshotMappingData(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed).length > 0;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true;
  }
}

function valuesFromParams(value: unknown, label: string, warnings: Set<string>): string[] {
  if (value === undefined || value === null || value === '') return [];
  const parsed = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : null;
  if (!Array.isArray(parsed)) {
    warnings.add(`原任务的${label}记录无法识别。`);
    return [];
  }
  if (parsed.some((item) => typeof item !== 'string')) {
    warnings.add(`原任务的${label}含无法识别的素材记录。`);
  }
  return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function readStoredUrls(
  raw: string | null | undefined,
  label: string,
  role: AssetRole,
  candidates: ReuseCandidate[],
  warnings: Set<string>,
) {
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.add(`原任务的${label}记录无法识别。`);
    return;
  }
  if (!Array.isArray(parsed)) {
    warnings.add(`原任务的${label}记录无法识别。`);
    return;
  }
  if (parsed.some((item) => typeof item !== 'string')) warnings.add(`原任务的${label}含无法识别的素材记录。`);
  for (const url of parsed) {
    if (typeof url === 'string' && url.trim()) candidates.push({ url: url.trim(), role });
  }
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }
    assertInternalOnly(user, '外部账号无权复用普通生成任务。');

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        provider: true,
        prompt: true,
        generation_mode: true,
        model: true,
        ratio: true,
        duration: true,
        resolution: true,
        seed: true,
        generate_audio: true,
        return_last_frame: true,
        watermark: true,
        reference_image_ids: true,
        reference_image_urls: true,
        reference_video_urls: true,
        reference_audio_urls: true,
        first_frame_url: true,
        last_frame_url: true,
        frame_image_urls: true,
        params_json: true,
        snapshot_id: true,
        project_id: true,
        video_card_id: true,
        video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
        owner_user_id: true,
        user_id: true,
        retention_status: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    await assertCanViewTask(user, task);

    const requestBody = await request.json().catch(() => ({}));
    const requestedSurface = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
      ? (requestBody as { surface?: unknown }).surface
      : undefined;
    if (requestedSurface === 'ip' || requestedSurface === 'normal') {
      const taskIsIp = task.provider === VOLCENGINE_IP_VIDEO_PROVIDER;
      if ((requestedSurface === 'ip') !== taskIsIp) {
        const targetPath = taskIsIp ? '/generate/ip' : '/generate';
        return NextResponse.json({
          error: '任务所属生成渠道与当前页面不一致',
          target_path: targetPath,
          draft: { provider: task.provider, target_path: targetPath },
        }, { status: 409 });
      }
    }

    const taskParams = parseParams(task.params_json);
    const warnings = new Set<string>();
    const candidates: ReuseCandidate[] = [];
    const requestedParameters = parseRecord(taskParams.requested_parameters);
    if (task.params_json && Object.keys(taskParams).length === 0) {
      warnings.add('原任务参数记录无法识别，部分参数可能需要重新设置。');
    }
    if (taskParams.requested_parameters != null && Object.keys(requestedParameters).length === 0) {
      warnings.add('原任务的原始参数快照无法识别，部分设置可能需要重新确认。');
    }
    const modelValue = originalParameter(taskParams, requestedParameters, 'model', 'model', task.model);
    const model = typeof modelValue === 'string' && modelValue.trim() ? modelValue : asString(task.model, '');
    const provider = asString(task.provider, asString(taskParams.provider, ''));
    const rawGenerationMode = originalParameter(taskParams, requestedParameters, 'generationMode', 'generation_mode', task.generation_mode);
    const generationMode = asString(rawGenerationMode, task.generation_mode);
    let ratioValue = originalParameter(taskParams, requestedParameters, 'ratio', 'ratio', task.ratio);
    if (ratioValue === 'adaptive' && typeof taskParams.ratio === 'string' && taskParams.ratio !== 'adaptive') {
      ratioValue = taskParams.ratio;
    }
    const ratio = asString(ratioValue, '16:9');
    const rawDuration = originalParameter(taskParams, requestedParameters, 'duration', 'duration', task.duration);
    const durationValue = asNumber(rawDuration, Number.NaN);
    const duration = Number.isFinite(durationValue) ? durationValue : 5;
    const rawResolution = originalParameter(taskParams, requestedParameters, 'resolution', 'resolution', task.resolution);
    const resolution = asString(rawResolution, '480p');
    const rawSeed = originalParameter(taskParams, requestedParameters, 'seed', 'seed', task.seed);
    const seed = typeof rawSeed === 'number' && Number.isInteger(rawSeed) ? rawSeed : -1;
    const rawGenerateAudio = originalParameter(taskParams, requestedParameters, 'generateAudio', 'generate_audio', task.generate_audio);
    const generateAudio = typeof rawGenerateAudio === 'boolean' ? rawGenerateAudio : true;
    const rawReturnLastFrame = originalParameter(taskParams, requestedParameters, 'returnLastFrame', 'return_last_frame', task.return_last_frame);
    const returnLastFrame = typeof rawReturnLastFrame === 'boolean' ? rawReturnLastFrame : false;
    const rawWatermark = originalParameter(taskParams, requestedParameters, 'watermark', 'watermark', task.watermark);
    const watermark = typeof rawWatermark === 'boolean' ? rawWatermark : false;
    if (typeof modelValue !== 'string' || !modelValue.trim()) warnings.add('原任务模型参数无法识别，已回退到任务记录中的模型。');
    if (!model) warnings.add('原任务模型无法安全恢复，请重新选择模型。');
    if (!provider) warnings.add('原任务服务渠道无法安全恢复，请重新选择渠道。');
    if (typeof rawGenerationMode !== 'string' || !rawGenerationMode.trim()) warnings.add('原任务生成模式参数无法识别，已回退到任务记录中的模式。');
    if (!VALID_GENERATION_MODES.has(generationMode)) warnings.add('原任务生成模式无法识别，请重新选择模式。');
    if (typeof ratioValue !== 'string' || !ratioValue.trim()) warnings.add('原任务画面比例无法识别，已暂用 16:9。');
    if (!VALID_RATIOS.has(ratio)) warnings.add('原任务画面比例当前无法识别，已保留原值，请重新确认。');
    if (rawDuration == null) warnings.add('原任务时长缺失，已暂用 5 秒。');
    else if (!Number.isFinite(durationValue)) warnings.add('原任务时长无法识别，已暂用 5 秒。');
    else if (!Number.isInteger(duration) || duration < 4 || duration > 30) warnings.add('原任务时长超出可识别范围，已保留原值，请重新确认。');
    if (typeof rawResolution !== 'string' || !rawResolution.trim()) warnings.add('原任务分辨率无法识别，已暂用 480p。');
    if (!VALID_RESOLUTIONS.has(resolution)) warnings.add('原任务分辨率当前无法识别，已保留原值，请重新确认。');
    if (rawSeed !== undefined && rawSeed !== null && (typeof rawSeed !== 'number' || !Number.isInteger(rawSeed))) {
      warnings.add('原任务随机种子无法识别，已暂用随机生成。');
    }
    if (asBool(valueFromParams(taskParams, 'resolutionApprovalConfirmed', 'resolution_approval_confirmed'), false)) {
      warnings.add('历史任务的分辨率确认不会沿用，提交前请重新确认。');
    }
    const snapshot = task.snapshot_id
      ? await prisma.generationTaskSnapshot.findUnique({
          where: { id: task.snapshot_id },
          select: { workspace_id: true, asset_mapping_json: true, content_json: true },
        })
      : await prisma.generationTaskSnapshot.findFirst({
          where: { task_id: task.id },
          select: { workspace_id: true, asset_mapping_json: true, content_json: true },
        });
    const snapshotAssetIds = parseSnapshotAssetIds(snapshot?.asset_mapping_json);
    const snapshotContent = parseSnapshotContent(snapshot?.content_json);

    if (hasSnapshotMappingData(snapshot?.asset_mapping_json) && snapshotAssetIds.length === 0) {
      warnings.add('原任务快照中的素材顺序记录无法识别，将按任务字段尝试恢复。');
    }
    if (snapshot?.content_json && snapshotContent.length === 0) {
      warnings.add('原任务快照中的素材用途记录无法识别，将按素材类型尝试恢复。');
    }

    const referenceImageIds = uniquePreserveOrder([
      ...parseJsonArray(task.reference_image_ids),
      ...valuesFromParams(valueFromParams(taskParams, 'referenceImageIds', 'reference_image_ids'), '参考图片', warnings),
    ]);
    if (task.reference_image_ids && referenceImageIds.length === 0) {
      warnings.add('原任务的参考图片授权记录无法识别。');
    }
    const authorizedReferenceById = new Map<string, { assetId: string; id: string }>();
    const authorizedReferenceByAsset = new Map<string, string>();
    const authorizedReferenceCandidates: ReuseCandidate[] = [];
    const unavailableReferenceImageIds = new Set<string>();

    for (const referenceImageId of referenceImageIds) {
      try {
        const image = await assertCanUseReferenceImage(user, referenceImageId);
        if (!image.asset_id) {
          unavailableReferenceImageIds.add(image.id);
          continue;
        }
        authorizedReferenceById.set(image.id, { assetId: image.asset_id, id: image.id });
        if (!authorizedReferenceByAsset.has(image.asset_id)) {
          authorizedReferenceByAsset.set(image.asset_id, image.id);
        }
        authorizedReferenceCandidates.push({ assetId: image.asset_id, role: 'reference_image', referenceImageId: image.id });
      } catch {
        unavailableReferenceImageIds.add(referenceImageId);
      }
    }

    const sourceWorkspaceItems = snapshot?.workspace_id && snapshotAssetIds.length > 0
      ? await prisma.workspaceAsset.findMany({
          where: { workspace_id: snapshot.workspace_id, asset_id: { in: snapshotAssetIds } },
          select: { asset_id: true, role: true, reference_image_id: true, sort_order: true },
        })
      : [];
    const sourceItemByAsset = new Map(sourceWorkspaceItems.map((item) => [item.asset_id, item]));
    const snapshotAssets = snapshotAssetIds.length > 0
      ? await prisma.asset.findMany({
          where: { id: { in: snapshotAssetIds } },
          select: { id: true, type: true, original_url: true },
        })
      : [];
    const snapshotAssetById = new Map(snapshotAssets.map((asset) => [asset.id, asset]));
    const consumedSnapshotItems = new Set<number>();

    for (const assetId of snapshotAssetIds) {
      const sourceItem = sourceItemByAsset.get(assetId);
      const snapshotAsset = snapshotAssetById.get(assetId);
      const assetType = snapshotAsset?.type || '';
      const sourceType = assetType === 'image' ? 'image_url' : assetType === 'video' ? 'video_url' : assetType === 'audio' ? 'audio_url' : '';
      const exactContentIndex = snapshotContent.findIndex((item, index) => (
        !consumedSnapshotItems.has(index)
        && item.type === sourceType
        && contentUrl(item) === snapshotAsset?.original_url
      ));
      const fallbackContentIndex = exactContentIndex >= 0
        ? exactContentIndex
        : snapshotContent.findIndex((item, index) => !consumedSnapshotItems.has(index) && item.type === sourceType);
      const contentItem = fallbackContentIndex >= 0 ? snapshotContent[fallbackContentIndex] : null;
      if (fallbackContentIndex >= 0) consumedSnapshotItems.add(fallbackContentIndex);
      const rawRole = contentItem?.role ?? sourceItem?.role;
      const role = roleForType(rawRole, assetType) || 'reference_image';
      const roleNeedsWarning = !rawRole || role !== rawRole;
      candidates.push({
        assetId,
        role,
        referenceImageId: sourceItem?.reference_image_id || authorizedReferenceByAsset.get(assetId),
        roleNeedsWarning,
      });
    }
    const snapshotAssetIdSet = new Set(snapshotAssetIds);
    candidates.push(...authorizedReferenceCandidates.filter((candidate) => !snapshotAssetIdSet.has(candidate.assetId || '')));
    const hasLegacyMaterials = referenceImageIds.length > 0
      || parseJsonArray(task.reference_image_urls).length > 0
      || parseJsonArray(task.reference_video_urls).length > 0
      || parseJsonArray(task.reference_audio_urls).length > 0
      || parseJsonArray(task.frame_image_urls).length > 0
      || Boolean(task.first_frame_url || task.last_frame_url)
      || snapshotContent.some((item) => Boolean(contentUrl(item)));
    if (snapshotAssetIds.length === 0 && hasLegacyMaterials) {
      warnings.add('原任务没有可用的素材顺序快照，已按任务字段顺序恢复素材。');
    }

    readStoredUrls(task.reference_image_urls, '参考图片', 'reference_image', candidates, warnings);
    readStoredUrls(task.reference_video_urls, '参考视频', 'reference_video', candidates, warnings);
    readStoredUrls(task.reference_audio_urls, '参考音频', 'reference_audio', candidates, warnings);
    if (task.first_frame_url) candidates.push({ url: task.first_frame_url, role: 'first_frame' });
    if (task.last_frame_url) candidates.push({ url: task.last_frame_url, role: 'last_frame' });
    readStoredUrls(task.frame_image_urls, '多帧图片', 'reference_image', candidates, warnings);

    const parameterUrlGroups: Array<[unknown, string, AssetRole]> = [
      [valueFromParams(taskParams, 'referenceImageUrls', 'reference_image_urls'), '参考图片', 'reference_image'],
      [valueFromParams(taskParams, 'referenceVideoUrls', 'reference_video_urls'), '参考视频', 'reference_video'],
      [valueFromParams(taskParams, 'referenceAudioUrls', 'reference_audio_urls'), '参考音频', 'reference_audio'],
      [valueFromParams(taskParams, 'frameImageUrls', 'frame_image_urls'), '多帧图片', 'reference_image'],
    ];
    for (const [value, label, role] of parameterUrlGroups) {
      for (const url of valuesFromParams(value, label, warnings)) candidates.push({ url, role });
    }
    const firstFrameUrl = valueFromParams(taskParams, 'firstFrameUrl', 'first_frame_url');
    const lastFrameUrl = valueFromParams(taskParams, 'lastFrameUrl', 'last_frame_url');
    if (!task.first_frame_url && typeof firstFrameUrl === 'string' && firstFrameUrl.trim()) {
      candidates.push({ url: firstFrameUrl.trim(), role: 'first_frame' });
    }
    if (!task.last_frame_url && typeof lastFrameUrl === 'string' && lastFrameUrl.trim()) {
      candidates.push({ url: lastFrameUrl.trim(), role: 'last_frame' });
    }

    for (const item of snapshotContent) {
      const url = contentUrl(item);
      const type = item.type === 'image_url' ? 'image' : item.type === 'video_url' ? 'video' : item.type === 'audio_url' ? 'audio' : '';
      const role = roleForType(item.role, type);
      if (url && role) candidates.push({ url, role });
    }

    const allCandidateAssetIds = uniquePreserveOrder([
      ...snapshotAssetIds,
      ...candidates.flatMap((candidate) => candidate.assetId ? [candidate.assetId] : []),
      ...Array.from(authorizedReferenceById.values(), (image) => image.assetId),
    ]);
    const allCandidateUrls = uniquePreserveOrder(candidates.flatMap((candidate) => candidate.url ? [candidate.url] : []));
    const assetFilters = [
      ...(allCandidateAssetIds.length > 0 ? [{ id: { in: allCandidateAssetIds } }] : []),
      ...(allCandidateUrls.length > 0 ? [{ original_url: { in: allCandidateUrls } }] : []),
    ];
    const assets = assetFilters.length > 0
      ? await prisma.asset.findMany({
          where: { OR: assetFilters },
          select: {
            id: true,
            type: true,
            original_url: true,
            status: true,
            reference_images: { select: { id: true } },
          },
        }) as ReuseAsset[]
      : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const assetByUrl = new Map(assets.map((asset) => [asset.original_url, asset]));

    const preparedItems: Array<{ assetId: string; role: AssetRole; referenceImageId: string | null }> = [];
    const preparedRoleByAsset = new Map<string, AssetRole>();
    const skippedMaterialKeys = new Set<string>();
    const directAccessCache = new Map<string, boolean>();
    const hasDirectAssetAccess = async (assetId: string) => {
      const cached = directAccessCache.get(assetId);
      if (cached !== undefined) return cached;
      const allowed = await canUseDirectAsset(user, assetId);
      directAccessCache.set(assetId, allowed);
      return allowed;
    };
    const markSkipped = (candidate: ReuseCandidate, asset?: ReuseAsset) => {
      skippedMaterialKeys.add(asset?.id || candidate.assetId || candidate.url || `${candidate.role}:unknown`);
    };

    for (const candidate of candidates) {
      const asset = (candidate.assetId ? assetById.get(candidate.assetId) : undefined)
        || (candidate.url ? assetByUrl.get(candidate.url) : undefined);
      const role = asset ? roleForType(candidate.role, asset.type) : null;
      if (!asset || asset.status !== 'active' || !role) {
        markSkipped(candidate, asset);
        continue;
      }
      const priorRole = preparedRoleByAsset.get(asset.id);
      if (priorRole) {
        if (priorRole !== role) warnings.add('同一素材在原任务中有多个用途；工作区仅能保留一个用途，已保留首次出现的用途。');
        continue;
      }

      let referenceImageId: string | null = null;
      if (candidate.referenceImageId) {
        const authorized = authorizedReferenceById.get(candidate.referenceImageId);
        if (authorized?.assetId === asset.id) {
          referenceImageId = authorized.id;
        } else {
          try {
            const image = await assertCanUseReferenceImage(user, candidate.referenceImageId);
            if (image.asset_id === asset.id) referenceImageId = image.id;
          } catch {
            if (!(await hasDirectAssetAccess(asset.id))) {
              markSkipped(candidate, asset);
              continue;
            }
          }
        }
      }

      if (!referenceImageId && !(await hasDirectAssetAccess(asset.id))) {
        let authorizedSharedReference: string | null = null;
        for (const referenceImage of asset.reference_images) {
          try {
            const image = await assertCanUseReferenceImage(user, referenceImage.id);
            if (image.asset_id === asset.id) {
              authorizedSharedReference = image.id;
              break;
            }
          } catch {
            // Try other reference-image grants for this asset.
          }
        }
        if (!authorizedSharedReference) {
          markSkipped(candidate, asset);
          continue;
        }
        referenceImageId = authorizedSharedReference;
      }

      if (candidate.roleNeedsWarning || candidate.role !== role) {
        warnings.add('部分历史素材用途与素材类型不匹配，已按素材类型恢复。');
      }
      preparedRoleByAsset.set(asset.id, role);
      preparedItems.push({ assetId: asset.id, role, referenceImageId });
    }

    if (unavailableReferenceImageIds.size > 0) {
      const unresolvedReferenceIds = Array.from(unavailableReferenceImageIds);
      const unresolvedReferences = await prisma.referenceImage.findMany({
        where: { id: { in: unresolvedReferenceIds } },
        select: { id: true, asset_id: true },
      });
      const unresolvedById = new Map(unresolvedReferences.map((image) => [image.id, image]));
      for (const id of unresolvedReferenceIds) {
        const image = unresolvedById.get(id);
        if (!image?.asset_id) {
          skippedMaterialKeys.add(`reference:${id}`);
        } else if (!preparedRoleByAsset.has(image.asset_id) && !skippedMaterialKeys.has(image.asset_id)) {
          skippedMaterialKeys.add(image.asset_id);
        }
      }
    }

    const skippedReferences = skippedMaterialKeys.size;
    if (skippedReferences > 0) {
      warnings.add(`有 ${skippedReferences} 项历史素材缺失、已停用或当前账号无权使用，未加入工作区。`);
    }
    const restoredCounts = {
      image: preparedItems.filter((item) => item.role === 'reference_image' || item.role === 'first_frame' || item.role === 'last_frame').length,
      video: preparedItems.filter((item) => item.role === 'reference_video').length,
      audio: preparedItems.filter((item) => item.role === 'reference_audio').length,
    };
    const mediaCapabilities = seedanceReferenceMediaCapabilities(model);
    const limits = {
      image: mediaCapabilities.imageLimit,
      video: mediaCapabilities.videoLimit,
      audio: mediaCapabilities.audioLimit,
    };
    const overLimit = Object.entries(limits)
      .filter(([kind, limit]) => restoredCounts[kind as keyof typeof restoredCounts] > limit)
      .map(([kind, limit]) => `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'} ${restoredCounts[kind as keyof typeof restoredCounts]}/${limit}`);
    if (overLimit.length > 0) {
      warnings.add(`已尽量保留全部可恢复素材，但超过该模型支持数量（${overLimit.join('、')}），提交前需调整。`);
    }

    const hasUnparsedMaterialRecord = Array.from(warnings).some((warning) => (
      /素材|参考图片|参考视频|参考音频|多帧图片/.test(warning)
    ));
    const hasSourceMaterials = snapshotAssetIds.length > 0
      || candidates.length > 0
      || hasLegacyMaterials
      || hasUnparsedMaterialRecord;
    if (hasSourceMaterials && preparedItems.length === 0) {
      return NextResponse.json({
        error: '原任务素材均无法安全恢复，当前工作区未更改。',
        code: 'REUSE_ASSETS_UNAVAILABLE',
        restored_references: 0,
        skipped_references: skippedReferences,
        inputWarnings: Array.from(warnings),
      }, { status: 409 });
    }

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);
    await prisma.$transaction(async (tx) => {
      await tx.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });
      if (preparedItems.length > 0) {
        await tx.workspaceAsset.createMany({
          data: preparedItems.map((item, index) => ({
            workspace_id: workspaceId,
            asset_id: item.assetId,
            reference_image_id: item.referenceImageId,
            sort_order: index,
            role: item.role,
          })),
        });
      }
    });

    return NextResponse.json({
      draft: {
        task_id: task.id,
        provider,
        prompt: task.prompt,
        generation_mode: generationMode,
        model,
        ratio,
        duration,
        resolution,
        seed,
        generate_audio: generateAudio,
        return_last_frame: returnLastFrame,
        watermark,
        resolution_approval_confirmed: false,
        project_id: task.project_id,
        video_card_id: task.video_card_id,
        video_card: task.video_card,
      },
      workspace_id: workspaceId,
      restored_references: preparedItems.length,
      skipped_references: skippedReferences,
      inputWarnings: Array.from(warnings),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }
    console.error('[ReuseTask]', error);
    return NextResponse.json(
      { error: '复用任务失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
