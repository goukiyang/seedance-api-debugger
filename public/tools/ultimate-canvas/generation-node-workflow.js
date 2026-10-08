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

    function videoMode(mode) {
        const value = VIDEO_MODES[mode] || VIDEO_MODES['text-to-video'];
        return { ...value };
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
        const mode = videoMode(input.mode);
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
        const durations = input.capabilities?.interaction?.duration_by_model?.[model];
        if (!model || !Array.isArray(durations)) errors.push('请选择当前可用的视频模型。');
        if (clean(input.prompt).length > 20000) errors.push('单个视频方案超过2万字，请调整分段。');
        if (!RATIOS.has(ratio)) errors.push('视频比例无效。');
        if (!Number.isInteger(duration) || !durations?.includes(duration)) errors.push('时长不在所选模型的能力范围内，请明确重新选择；不会自动截短。');
        if ((input.referenceImageIds || []).length > mode.maximumReferences) errors.push('参考图数量超过当前模式上限，请明确移除多余图片。');
        if (!RESOLUTIONS.has(resolution)) errors.push('视频分辨率无效。');
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
                    ...(clean(settings.model) ? { model: clean(settings.model) } : {}),
                    ratio: IMAGE_RATIOS.has(clean(settings.ratio)) ? clean(settings.ratio) : '16:9',
                    size: clean(settings.size) || '1K',
                    ...(clean(settings.resolution) ? { resolution: clean(settings.resolution) } : {}),
                    count: Math.max(1, Math.floor(Number(settings.count) || 1)),
                    reference_image_ids: uniqueStrings(input.referenceImageIds, 10),
                    mode: IMAGE_MODES[input.mode] ? input.mode : 'text-to-image'
                }
            }
        };
    }

    function videoRequest(input = {}) {
        const modeName = VIDEO_MODES[input.mode] ? input.mode : 'text-to-video';
        const mode = videoMode(modeName);
        const settings = input.settings || {};
        const ratio = clean(settings.ratio);
        const duration = Number(settings.duration);
        const resolution = clean(settings.resolution).toLowerCase();
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        const requestId = clean(input.requestId);
        const nodeId = clean(input.nodeId);
        return {
            url: '/api/tasks/create',
            method: 'POST',
            payload: {
                prompt,
                model: clean(settings.model),
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
                reference_image_ids: uniqueStrings(input.referenceImageIds, mode.maximumReferences),
                idempotency_key: `${nodeId}:${requestId}`,
                final_prompt_snapshot: prompt,
                prompt_user_edited: input.promptUserEdited !== false,
                client_name: 'ultimate_canvas',
                source_request_id: sourceRequestId(input),
                source_metadata: {
                    source: 'ultimate_canvas',
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
        return {
            taskId: result.task_id || result.id || '',
            providerTaskId: result.provider_task_id || result.providerTaskId || '',
            status: result.local_status || result.status || 'submitted',
            frozenCost: Number(result.frozen_cost ?? result.frozenCost ?? 0)
        };
    }

    function normalizeVideoStatus(result = {}) {
        const task = result.task && typeof result.task === 'object' ? result.task : result;
        const taskId = task.task_id || task.id || '';
        const status = task.local_status || task.status || 'submitted';
        const stableDownloadReady = task.stable_download_ready === true
            || task.stableDownloadReady === true
            || Boolean(task.public_video_url);
        const previewAvailable = task.preview_available === true
            || task.previewAvailable === true
            || Boolean(task.result_video_url || task.local_video_path || task.result_last_frame_url);
        const fallbackThumbnailUrl = previewAvailable && taskId
            ? `/api/video/thumbnail/${encodeURIComponent(taskId)}`
            : '';
        return {
            taskId,
            status,
            errorMessage: task.error_message || task.message || '',
            resultVideoUrl: task.result_video_url || task.video_url || '',
            resultLastFrameUrl: task.result_last_frame_url || '',
            thumbnailUrl: task.thumbnail_url || task.thumbnailUrl || fallbackThumbnailUrl,
            playUrl: task.play_url || task.playUrl || (previewAvailable && taskId ? `/api/video/play/${encodeURIComponent(taskId)}` : ''),
            downloadUrl: task.download_url || task.downloadUrl || (stableDownloadReady && taskId ? `/api/video/download/${encodeURIComponent(taskId)}` : ''),
            stableDownloadReady,
            previewAvailable,
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
        videoTaskSnapshot,
        uniqueStrings
    };
});
