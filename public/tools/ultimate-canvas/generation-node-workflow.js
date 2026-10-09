(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasGenerationNodes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const IMAGE_MODES = {
        'text-to-image': { action: 'text_to_image_reference', requiresReference: false },
        'image-to-image': { action: 'image_variant', requiresReference: true },
        'upscale-image': { action: 'image_variant', requiresReference: true },
        'first-frame-draft': { action: 'first_frame_draft', requiresReference: false },
        'last-frame-draft': { action: 'last_frame_draft', requiresReference: false }
    };

    const VIDEO_MODES = {
        'text-to-video': { generationMode: 'all_in_one_reference', minimumReferences: 0, maximumReferences: 9 },
        'all-reference-video': { generationMode: 'all_in_one_reference', minimumReferences: 1, maximumReferences: 9 },
        'image-to-video': { generationMode: 'all_in_one_reference', minimumReferences: 1, maximumReferences: 9 },
        'first-frame-video': { generationMode: 'all_in_one_reference', minimumReferences: 1, maximumReferences: 1 },
        'first-last-frame-video': { generationMode: 'first_last_frame', minimumReferences: 1, maximumReferences: 2 },
        'image-reference-video': { generationMode: 'all_in_one_reference', minimumReferences: 1, maximumReferences: 9 },
        'smart-multi-frame-video': { generationMode: 'smart_multi_frame', minimumReferences: 2, maximumReferences: 9 }
    };

    const RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
    const IMAGE_RATIOS = new Set(['auto', ...RATIOS]);
    const RESOLUTIONS = new Set(['480p', '720p', '1080p']);

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function uniqueStrings(values, limit = Infinity) {
        const seen = new Set();
        const result = [];
        (Array.isArray(values) ? values : []).forEach(value => {
            const next = clean(value);
            if (!next || seen.has(next) || result.length >= limit) return;
            seen.add(next);
            result.push(next);
        });
        return result;
    }

    function imageMode(mode) {
        const value = IMAGE_MODES[mode] || IMAGE_MODES['text-to-image'];
        return { ...value };
    }

    function requestReferenceIds(input, maximum) {
        if (input.promptMentions == null) return uniqueStrings(input.referenceImageIds, maximum);
        const values = input.referenceImageIds || [];
        if (!Array.isArray(values) || values.length > maximum || values.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('绑定参考图清单无效或超限，请重新选择。');
        if (new Set(values).size !== values.length) throw new Error('绑定参考图重复，未改变首尾角色或发送顺序，请重新选择。');
        return values.slice();
    }

    function videoMode(mode, referenceLimit = 9) {
        const value = VIDEO_MODES[mode] || VIDEO_MODES['text-to-video'];
        return { ...value, maximumReferences: value.maximumReferences === 9 && Number.isInteger(referenceLimit) && referenceLimit > 0 && referenceLimit <= 30 ? referenceLimit : value.maximumReferences };
    }

    function contextErrors(input) {
        const errors = [];
        if (!clean(input?.projectId)) errors.push('请先选择可生成的项目。');
        if (!clean(input?.cardId)) errors.push('请先选择可生成的视频卡。');
        return errors;
    }

    function validateImage(input = {}) {
        const mode = imageMode(input.mode);
        const references = uniqueStrings(input.referenceImageIds, 10);
        const errors = contextErrors(input);
        if (!clean(input.prompt) && input.mode !== 'upscale-image') errors.push('请先填写图片提示词。');
        if (mode.requiresReference && references.length === 0) errors.push('当前图片模式至少需要一张已入库参考图。');
        return { valid: errors.length === 0, errors, message: errors[0] || '' };
    }

    function validateVideo(input = {}) {
        const selectedOption = input.capabilities?.model_options?.find(item => item.value === input.settings?.model);
        const mode = videoMode(input.mode, selectedOption?.reference_media?.imageLimit);
        const references = uniqueStrings(input.referenceImageIds, mode.maximumReferences);
        const settings = input.settings || {};
        const errors = contextErrors(input);
        if (!clean(input.prompt)) errors.push('请先填写视频提示词。');
        if (references.length < mode.minimumReferences) {
            errors.push(mode.generationMode === 'first_last_frame'
                ? '首尾帧模式至少需要一张已入库图片作为首帧。'
                : '当前视频模式至少需要一张已入库参考图。');
        }
        const ratio = clean(settings.ratio);
        const duration = Number(settings.duration);
        const resolution = clean(settings.resolution).toLowerCase();
        const model = clean(settings.model);
        const option = input.capabilities?.model_options?.find(item => item.value === model);
        const durations = input.capabilities?.interaction?.duration_by_model?.[model];
        if (!model || !Array.isArray(durations)) errors.push('请选择当前可用的视频模型。');
        if (option?.ready === false) errors.push('所选视频接口尚未配置，请联系管理员或选择可用模型。');
        if (option && option.provider !== (settings.provider || 'seedance')) errors.push('模型与生成接口不匹配，请重新选择模型。');
        if (clean(input.prompt).length > 20000) errors.push('单个视频方案超过2万字，请调整分段。');
        if (!RATIOS.has(ratio)) errors.push('视频比例无效。');
        if (!Number.isInteger(duration) || !durations?.includes(duration)) errors.push('时长不在所选模型的能力范围内，请明确重新选择；不会自动截短。');
        if ((input.referenceImageIds || []).length > mode.maximumReferences) errors.push('参考图数量超过当前模式上限，请明确移除多余图片。');
        if (!RESOLUTIONS.has(resolution)) errors.push('视频分辨率无效。');
        if (option?.resolutions && !option.resolutions.includes(resolution)) errors.push('所选模型不支持此分辨率，请重新选择；原值未被替换。');
        return { valid: errors.length === 0, errors, message: errors[0] || '' };
    }

    function sourceRequestId(input) {
        return `ultimate_canvas:${clean(input.nodeId)}:${clean(input.requestId)}`;
    }

    function imageRequest(input = {}) {
        const mode = imageMode(input.mode);
        const settings = input.settings || {};
        const prompt = clean(input.prompt) || '提升参考图片的清晰度、细节和质感，保持原始构图与主体。';
        return {
            url: '/api/assets/generate',
            method: 'POST',
            payload: {
                project_id: clean(input.projectId),
                video_card_id: clean(input.cardId),
                canvas_document_id: clean(input.documentId),
                canvas_node_id: clean(input.nodeId),
                tab_id: clean(input.workspaceKey),
                source_request_id: sourceRequestId(input),
                action: mode.action,
                input: {
                    prompt,
                    ...(input.promptMentions ? { promptMentions: input.promptMentions } : {}),
                    ...(clean(settings.model) ? { model: clean(settings.model) } : {}),
                    ...(clean(settings.quality) ? { quality: clean(settings.quality) } : {}),
                    ratio: clean(settings.requestedRatio) || (IMAGE_RATIOS.has(clean(settings.ratio)) ? clean(settings.ratio) : '16:9'),
                    size: clean(settings.size) || '1K',
                    ...(clean(settings.resolution) ? { resolution: clean(settings.resolution) } : {}),
                    count: Math.max(1, Math.floor(Number(settings.count) || 1)),
                    reference_image_ids: requestReferenceIds(input, 10),
                    mode: IMAGE_MODES[input.mode] ? input.mode : 'text-to-image'
                }
            }
        };
    }

    function videoRequest(input = {}) {
        const modeName = VIDEO_MODES[input.mode] ? input.mode : 'text-to-video';
        const settings = input.settings || {};
        const mode = videoMode(modeName, settings.referenceImageLimit);
        const ratio = clean(settings.ratio);
        const duration = Number(settings.duration);
        const resolution = clean(settings.resolution).toLowerCase();
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        const requestId = clean(input.requestId);
        const nodeId = clean(input.nodeId);
        return {
            url: settings.provider === 'volcengine_ip' ? '/api/ip/tasks/create' : '/api/tasks/create',
            method: 'POST',
            payload: {
                prompt,
                ...(input.promptMentions ? { promptMentions: input.promptMentions } : {}),
                model: clean(settings.model),
                ...(Number.isFinite(settings.maxEstimatedCost) ? { max_estimated_cost: settings.maxEstimatedCost } : {}),
                generation_mode: mode.generationMode,
                ratio,
                duration,
                resolution,
                seed: Number.isInteger(settings.seed) ? settings.seed : -1,
                generate_audio: settings.generateAudio === true,
                return_last_frame: settings.returnLastFrame === true,
                watermark: settings.watermark === true,
                project_id: clean(input.projectId),
                video_card_id: clean(input.cardId),
                video_branch_id: clean(input.branchId),
                reference_image_ids: requestReferenceIds(input, mode.maximumReferences),
                idempotency_key: `${nodeId}:${requestId}`,
                final_prompt_snapshot: prompt,
                prompt_user_edited: input.promptUserEdited !== false,
                client_name: 'ultimate_canvas',
                source_request_id: sourceRequestId(input),
                source_metadata: {
                    source: 'ultimate_canvas',
                    provider: settings.provider || 'seedance',
                    canvas_document_id: clean(input.documentId),
                    canvas_node_id: nodeId,
                    video_branch_id: clean(input.branchId),
                    mode: modeName,
                    workspace_key: clean(input.workspaceKey)
                }
            }
        };
    }

    function normalizeImageResult(result = {}) {
        const assets = Array.isArray(result.assets) ? result.assets : [];
        const first = assets[0] || {};
        const assetId = result.asset_id || result.assetId || first.assetId || first.asset_id || null;
        const referenceImageId = result.reference_image_id || result.referenceImageId
            || first.referenceImageId || first.reference_image_id || null;
        const workspaceAssetId = result.workspace_asset_id || result.workspaceAssetId
            || first.workspaceAssetId || first.workspace_asset_id || null;
        const originalUrl = result.original_url || result.originalUrl || first.originalUrl || first.original_url || '';
        const thumbnailUrl = result.thumbnail_url || result.thumbnailUrl || first.thumbnailUrl || first.thumbnail_url || '';
        return {
            status: 'succeeded',
            assetId,
            referenceImageId,
            workspaceAssetId,
            originalUrl,
            thumbnailUrl,
            imageUrl: thumbnailUrl || originalUrl,
            fileName: result.file_name || result.fileName || first.fileName || first.file_name || '',
            assets
        };
    }

    function normalizeVideoCreate(result = {}) {
        const status = videoReceptionStatus(result);
        return {
            taskId: result.task_id || result.id || '',
            providerTaskId: result.provider_task_id || result.providerTaskId || '',
            status,
            submissionUnconfirmed: status === 'unconfirmed',
            frozenCost: Number(result.frozen_cost ?? result.frozenCost ?? 0)
        };
    }

    function videoReceptionStatus(task = {}) {
        const status = task.local_status || task.status || 'submitted';
        return task.submission_unconfirmed || task.error_code === 'IP_SUBMISSION_UNCONFIRMED'
            || status === 'unconfirmed'
            || (['queued', 'submitted', 'running', 'processing', 'pending', 'failed'].includes(status) && !(task.provider_task_id || task.providerTaskId))
            ? 'unconfirmed' : status;
    }

    function explicitBooleanValue(value, snakeKey, camelKey) {
        if (value?.[snakeKey] === false || value?.[camelKey] === false) return false;
        if (value?.[snakeKey] === true || value?.[camelKey] === true) return true;
        return null;
    }

    function hasTrustedPlayableSource(task, resultVideoUrl) {
        const publicVideoUrl = task.public_video_url || task.publicVideoUrl;
        const localVideoPath = task.local_video_path || task.localVideoPath;
        const trustedResultVideo = [
            resultVideoUrl,
            task.result_video_url,
            task.resultVideoUrl,
            task.video_url,
            task.videoUrl
        ].some(value => typeof value === 'string'
            && value.trim()
            && !/^h3-internal-output:\/\//i.test(value.trim()));
        return Boolean(publicVideoUrl || localVideoPath || trustedResultVideo);
    }

    function canonicalVideoPlayPath(taskId) {
        return taskId ? `/api/video/play/${encodeURIComponent(taskId)}` : '';
    }

    function isCanonicalVideoPlayUrl(taskId, value) {
        const canonicalPath = canonicalVideoPlayPath(taskId);
        if (!canonicalPath || typeof value !== 'string' || !value.trim()) return false;
        const candidate = value.trim();
        if (candidate === canonicalPath) return true;

        const currentLocation = typeof globalThis !== 'undefined' ? globalThis.location : null;
        if (!currentLocation?.origin || typeof URL !== 'function') return false;
        try {
            const parsed = new URL(candidate, currentLocation.href);
            return parsed.origin === currentLocation.origin
                && parsed.pathname === canonicalPath
                && !parsed.search
                && !parsed.hash
                && !parsed.username
                && !parsed.password;
        } catch {
            return false;
        }
    }

    function normalizeVideoDeliveryStage(task) {
        const stage = task.delivery_stage || task.deliveryStage;
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return null;
        const normalized = {};
        if (typeof stage.key === 'string') normalized.key = stage.key;
        if (typeof stage.label === 'string') normalized.label = stage.label;
        const stableDownloadReady = explicitBooleanValue(stage, 'stable_download_ready', 'stableDownloadReady');
        const previewAvailable = explicitBooleanValue(stage, 'preview_available', 'previewAvailable');
        if (stableDownloadReady !== null) normalized.stableDownloadReady = stableDownloadReady;
        if (previewAvailable !== null) normalized.previewAvailable = previewAvailable;
        return Object.keys(normalized).length ? normalized : null;
    }

    function normalizeVideoStatus(result = {}) {
        const task = result.task && typeof result.task === 'object' ? result.task : result;
        const taskId = task.task_id || task.taskId || task.id || '';
        const status = videoReceptionStatus(task);
        const publicVideoUrl = task.public_video_url || task.publicVideoUrl || '';
        const resultVideoUrl = task.result_video_url || task.resultVideoUrl || task.video_url || task.videoUrl || '';
        const resultLastFrameUrl = task.result_last_frame_url || task.resultLastFrameUrl || '';
        const deliveryStage = normalizeVideoDeliveryStage(task);
        const stableExplicit = explicitBooleanValue(task, 'stable_download_ready', 'stableDownloadReady');
        const stageStableExplicit = explicitBooleanValue(deliveryStage, 'stable_download_ready', 'stableDownloadReady');
        const stableDownloadReady = stableExplicit !== null
            ? stableExplicit
            : stageStableExplicit !== null
                ? stageStableExplicit
                : Boolean(publicVideoUrl);
        const previewExplicit = explicitBooleanValue(task, 'preview_available', 'previewAvailable');
        const stagePreviewExplicit = explicitBooleanValue(deliveryStage, 'preview_available', 'previewAvailable');
        const previewAvailable = previewExplicit !== null ? previewExplicit
            : stagePreviewExplicit !== null ? stagePreviewExplicit
                : hasTrustedPlayableSource(task, resultVideoUrl) || Boolean(resultLastFrameUrl);
        const playableExplicit = explicitBooleanValue(task, 'playable_available', 'playableAvailable');
        const legacyCanonicalPlayUrl = task.play_url || task.playUrl || '';
        const trustedSource = hasTrustedPlayableSource(task, resultVideoUrl);
        const internalOnly = /^h3-internal-output:\/\//i.test(String(resultVideoUrl).trim()) && !trustedSource;
        const playableAvailable = playableExplicit !== null
            ? playableExplicit
            : trustedSource || (!internalOnly && isCanonicalVideoPlayUrl(taskId, legacyCanonicalPlayUrl));
        const fallbackThumbnailUrl = previewAvailable && taskId
            ? `/api/video/thumbnail/${encodeURIComponent(taskId)}`
            : '';
        const playUrl = playableAvailable ? canonicalVideoPlayPath(taskId) : '';
        const downloadUrl = stableDownloadReady && taskId ? `/api/video/download/${encodeURIComponent(taskId)}` : '';
        return {
            taskId,
            status,
            submissionUnconfirmed: status === 'unconfirmed',
            errorMessage: task.error_message || task.message || '',
            resultVideoUrl,
            resultLastFrameUrl,
            thumbnailUrl: task.thumbnail_url || task.thumbnailUrl || fallbackThumbnailUrl,
            playUrl,
            stableDownloadReady,
            previewAvailable,
            playableAvailable,
            deliveryStage,
            downloadUrl,
            retryAfterMs: Number(task.retry_after_ms ?? task.retryAfterMs ?? 0) || null
        };
    }

    // Keep database payloads and serialized reference lists out of canvas drafts.
    function videoTaskSnapshot(task = {}) {
        const status = normalizeVideoStatus(task);
        return {
            task_id: status.taskId,
            provider_task_id: task.provider_task_id || task.providerTaskId || null,
            local_status: status.status,
            error_message: status.errorMessage,
            result_video_url: status.resultVideoUrl,
            result_last_frame_url: status.resultLastFrameUrl,
            thumbnail_url: status.thumbnailUrl,
            play_url: status.playUrl,
            download_url: status.downloadUrl,
            stable_download_ready: status.stableDownloadReady,
            preview_available: status.previewAvailable,
            playable_available: status.playableAvailable,
            delivery_stage: status.deliveryStage,
            retry_after_ms: status.retryAfterMs
        };
    }

    return {
        imageMode,
        videoMode,
        validateImage,
        validateVideo,
        imageRequest,
        videoRequest,
        normalizeImageResult,
        normalizeVideoCreate,
        normalizeVideoStatus,
        videoReceptionStatus,
        videoTaskSnapshot,
        uniqueStrings
    };
});
