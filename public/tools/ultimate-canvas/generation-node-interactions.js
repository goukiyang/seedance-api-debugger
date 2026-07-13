(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasGenerationInteractions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODE_DEFINITIONS = Object.freeze({
        image: Object.freeze([
            { id: 'text-to-image', label: '文生图', minimumReferences: 0, maximumReferences: 10 },
            { id: 'image-to-image', label: '图生图', minimumReferences: 1, maximumReferences: 10 },
            { id: 'upscale-image', label: '高清修复', minimumReferences: 1, maximumReferences: 1 },
            { id: 'first-frame-draft', label: '首帧草图', minimumReferences: 0, maximumReferences: 10 },
            { id: 'last-frame-draft', label: '尾帧草图', minimumReferences: 0, maximumReferences: 10 }
        ]),
        video: Object.freeze([
            { id: 'text-to-video', label: '文生视频', minimumReferences: 0, maximumReferences: 9 },
            { id: 'all-reference-video', label: '全部参考', minimumReferences: 1, maximumReferences: 9 },
            { id: 'image-to-video', label: '图生视频', minimumReferences: 1, maximumReferences: 9 },
            { id: 'first-frame-video', label: '首帧视频', minimumReferences: 1, maximumReferences: 1 },
            { id: 'first-last-frame-video', label: '首尾帧', minimumReferences: 1, maximumReferences: 2 },
            { id: 'image-reference-video', label: '图片参考', minimumReferences: 1, maximumReferences: 9 },
            { id: 'smart-multi-frame-video', label: '智能多帧', minimumReferences: 2, maximumReferences: 9 }
        ])
    });

    const VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
    const VALID_VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p']);
    const VALID_IMAGE_RESOLUTIONS = new Set(['1K', '2K']);
    const GENERATION_RATIOS = Object.freeze({
        '21:9': [21, 9], '16:9': [16, 9], '4:3': [4, 3],
        '1:1': [1, 1], '3:4': [3, 4], '9:16': [9, 16]
    });
    const DEFAULTS = Object.freeze({
        image: Object.freeze({ modes: MODE_DEFINITIONS.image.map(mode => mode.id), ratios: ['1:1', '4:3', '16:9', '9:16'], durations: [], resolutions: ['1K', '2K'], supportsAudio: false, supportsLastFrame: false, supportsWatermark: false, maxReferenceImages: 10 }),
        video: Object.freeze({ modes: MODE_DEFINITIONS.video.map(mode => mode.id), ratios: ['16:9', '9:16'], durations: [5, 10], resolutions: ['720p', '1080p'], supportsAudio: false, supportsLastFrame: false, supportsWatermark: true, maxReferenceImages: 9 })
    });

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function generationNodeDimensions(ratio, longEdge = 350) {
        const normalizedRatio = Object.hasOwn(GENERATION_RATIOS, clean(ratio)) ? clean(ratio) : '16:9';
        const [numerator, denominator] = GENERATION_RATIOS[normalizedRatio];
        const edge = Number.isFinite(Number(longEdge)) && Number(longEdge) > 0 ? Number(longEdge) : 350;
        const scale = edge / Math.max(numerator, denominator);
        const round = value => Math.round(value * 1000) / 1000;
        return {
            ratio: normalizedRatio,
            numerator,
            denominator,
            width: round(numerator * scale),
            height: round(denominator * scale)
        };
    }

    function generationNodeLongEdge(nodeType, viewportWidth) {
        const maximum = clean(nodeType) === 'image' ? 640 : 350;
        const width = Number(viewportWidth);
        const available = Number.isFinite(width) && width > 24 ? width - 24 : maximum;
        return Math.max(1, Math.min(maximum, available));
    }

    function strings(values, validator) {
        const seen = new Set();
        return (Array.isArray(values) ? values : []).filter(value => {
            if (typeof value !== 'string' || !validator(value) || seen.has(value)) return false;
            seen.add(value);
            return true;
        });
    }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object') return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function normalizedStrings(interaction, key, defaults, validator) {
        return hasOwn(interaction, key)
            ? strings(interaction[key], validator)
            : [...defaults];
    }

    function normalizeCapabilities(kind, capability) {
        const defaults = DEFAULTS[kind] || DEFAULTS.video;
        const interaction = isPlainObject(capability?.interaction) ? capability.interaction : {};
        const definitions = MODE_DEFINITIONS[kind] || MODE_DEFINITIONS.video;
        const validModes = new Set(definitions.map(mode => mode.id));
        const modes = normalizedStrings(interaction, 'modes', defaults.modes, value => validModes.has(value));
        const ratios = normalizedStrings(interaction, 'ratios', defaults.ratios, value => VALID_RATIOS.has(value));
        const durations = hasOwn(interaction, 'durations')
            ? (Array.isArray(interaction.durations) ? interaction.durations : []).filter(value => Number.isInteger(value) && value > 0)
            : [...defaults.durations];
        const validResolutions = kind === 'image' ? VALID_IMAGE_RESOLUTIONS : VALID_VIDEO_RESOLUTIONS;
        const resolutionKey = kind === 'image' && hasOwn(interaction, 'size_options') ? 'size_options' : 'resolutions';
        const resolutions = hasOwn(interaction, resolutionKey)
            ? strings(interaction[resolutionKey], value => validResolutions.has(value))
            : [...defaults.resolutions];
        const maxReferenceImages = Number.isInteger(interaction.max_reference_images) && interaction.max_reference_images >= 0
            ? interaction.max_reference_images : defaults.maxReferenceImages;
        const fixedSize = kind === 'image' && typeof capability?.size === 'string'
            ? capability.size.trim()
            : '';
        return {
            enabled: capability?.enabled === true,
            message: typeof capability?.message === 'string' ? capability.message : '',
            reason: typeof capability?.reason === 'string' ? capability.reason : '',
            modes,
            ratios,
            durations: [...new Set(durations)],
            resolutions,
            sizeOptions: kind === 'image' ? resolutions : [],
            fixedSize,
            supportsAudio: typeof interaction.supports_audio === 'boolean' ? interaction.supports_audio : defaults.supportsAudio,
            supportsLastFrame: typeof interaction.supports_last_frame === 'boolean' ? interaction.supports_last_frame : defaults.supportsLastFrame,
            supportsWatermark: typeof interaction.supports_watermark === 'boolean' ? interaction.supports_watermark : defaults.supportsWatermark,
            maxReferenceImages
        };
    }

    function modeOptions(kind, capability, referenceCount) {
        const definitions = MODE_DEFINITIONS[kind] || MODE_DEFINITIONS.video;
        const allowed = new Set(Array.isArray(capability?.modes) ? capability.modes : []);
        const count = Number.isFinite(referenceCount) ? Math.max(0, referenceCount) : 0;
        return definitions.filter(mode => allowed.has(mode.id)).map(mode => {
            mode = {
                ...mode,
                maximumReferences: Number.isInteger(capability?.maxReferenceImages)
                    ? Math.min(mode.maximumReferences, capability.maxReferenceImages)
                    : mode.maximumReferences
            };
            let reason = '';
            if (count < mode.minimumReferences) reason = `至少需要 ${mode.minimumReferences} 个参考图`;
            else if (count > mode.maximumReferences) reason = `最多支持 ${mode.maximumReferences} 个参考图`;
            return { ...mode, enabled: !reason, reason };
        });
    }

    const NONTERMINAL_GENERATION_STATUSES = new Set([
        'submitted', 'queued', 'pending', 'processing', 'running', 'in_progress', 'inprogress'
    ]);

    function normalizedGenerationStatus(status) {
        return typeof status === 'string'
            ? status.trim().toLowerCase().replace(/[\s-]+/g, '_')
            : '';
    }

    function videoTaskActionAvailability(context = {}) {
        const taskId = clean(context.taskId);
        if (!taskId) return null;
        const status = normalizedGenerationStatus(context.status);
        const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
        return {
            taskId,
            detailUrl: `/tasks?task=${encodeURIComponent(taskId)}`,
            previewUrl: clean(context.previewUrl),
            downloadUrl: clean(context.downloadUrl),
            canRetry: context.canRetry === true && terminal,
            canMarkVersion: context.canManage === true && status === 'succeeded'
        };
    }

    function isNonterminalGenerationStatus(status) {
        return NONTERMINAL_GENERATION_STATUSES.has(normalizedGenerationStatus(status));
    }

    function nodeHasNonterminalVideoTask(node) {
        if (!node || (node.type && node.type !== 'video')) return false;
        const data = node.data || node;
        if (!data.taskId) return false;
        return [
            data.generationStatus,
            data.local_status,
            data.status,
            data.generationResult?.local_status,
            data.generationResult?.status
        ].some(isNonterminalGenerationStatus);
    }

    function generationInteractionReadiness(kind, capability, nodeData, referenceCount, selectedMode, options = {}) {
        if (!capability?.enabled) {
            return { ready: false, message: capability?.message || capability?.reason || '当前生成能力不可用。' };
        }
        if (kind === 'video' && (options.transientPending || nodeHasNonterminalVideoTask(nodeData))) {
            return { ready: false, message: '当前视频任务仍在处理中，请等待完成后再生成。' };
        }
        const selected = modeOptions(kind, capability, referenceCount)
            .find(mode => mode.id === selectedMode);
        if (!selected) return { ready: false, message: capability.message || '当前没有可用的生成模式。' };
        if (!selected.enabled) return { ready: false, message: selected.reason };
        const hasSpec = kind === 'image'
            ? capability.ratios?.length > 0 && (capability.sizeOptions?.length > 0 || Boolean(capability.fixedSize))
            : capability.ratios?.length > 0 && capability.durations?.length > 0 && capability.resolutions?.length > 0;
        if (!hasSpec) return { ready: false, message: capability.reason || '当前没有可用的生成规格。' };
        return { ready: true };
    }

    function createGenerationSubmissionTracker() {
        const pending = new Map();
        return {
            start(nodeId, entry) {
                if (!nodeId || !entry || pending.has(nodeId)) return false;
                pending.set(nodeId, entry);
                return true;
            },
            finish(nodeId, entry) {
                if (pending.get(nodeId) !== entry) return false;
                return pending.delete(nodeId);
            },
            get: nodeId => pending.get(nodeId),
            has: nodeId => pending.has(nodeId),
            releaseAll(release) {
                const entries = Array.from(pending.entries());
                pending.clear();
                entries.forEach(([nodeId, entry]) => {
                    try {
                        release?.(entry, nodeId);
                    } catch {
                        // Continue releasing the remaining captured UI entries.
                    }
                });
                return entries.length;
            },
            clear() {
                const count = pending.size;
                pending.clear();
                return count;
            },
            size: () => pending.size
        };
    }

    function recoverTasklessNonterminalVideoNode(node) {
        if (!node || node.type !== 'video') return false;
        const data = node.data || {};
        if (data.taskId || ![
            data.generationStatus,
            data.local_status,
            data.status,
            data.generationResult?.local_status,
            data.generationResult?.status
        ].some(isNonterminalGenerationStatus)) return false;
        const recovered = { ...data, generationStatus: 'idle' };
        delete recovered.generationError;
        delete recovered.providerTaskId;
        if (isNonterminalGenerationStatus(recovered.local_status)) delete recovered.local_status;
        if (isNonterminalGenerationStatus(recovered.status)) delete recovered.status;
        if (recovered.generationResult && [
            recovered.generationResult.local_status,
            recovered.generationResult.status
        ].some(isNonterminalGenerationStatus)) {
            delete recovered.generationResult;
        }
        node.data = recovered;
        return true;
    }

    function referenceIdsFromNodeData(data = {}) {
        const ids = [];
        const visited = new Set();
        function visit(value) {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            ['referenceImageId', 'reference_image_id'].forEach(key => {
                if (typeof value[key] === 'string' && value[key]) ids.push(value[key]);
            });
            ['referenceImageIds', 'reference_image_ids'].forEach(key => {
                if (Array.isArray(value[key])) ids.push(...value[key].filter(item => typeof item === 'string' && item));
            });
            ['generationResult', 'result', 'output'].forEach(key => visit(value[key]));
            if (Array.isArray(value.assets)) value.assets.forEach(visit);
        }
        visit(data);
        return [...new Set(ids)];
    }

    function availableReferenceCount(items) {
        return (Array.isArray(items) ? items : [])
            .filter(item => referenceIdsFromNodeData(item?.data || item).length > 0)
            .length;
    }

    function captureGenerationContext(context) {
        return Object.freeze({
            epoch: context.epoch,
            projectId: context.projectId || null,
            videoCardId: context.videoCardId || null,
            documentId: context.documentId || null,
            nodeId: context.nodeId,
            node: context.node
        });
    }

    function generationContextMatches(captured, current) {
        return Boolean(captured && current
            && captured.epoch === current.epoch
            && captured.projectId === (current.projectId || null)
            && captured.videoCardId === (current.videoCardId || null)
            && captured.nodeId === current.nodeId
            && captured.node === current.node);
    }

    function cleanupGenerationSubmission(options) {
        options.clearLoading?.();
        if (!options.stale) return { resetStatus: false, removedStatus: false };
        const data = options.node?.data;
        let resetStatus = false;
        if (!options.preserveDurable && data?.generationStatus === 'submitted'
            && (data.taskId || null) === (options.previousTaskId || null)) {
            options.node.data = {
                ...data,
                generationStatus: options.previousStatus || 'idle'
            };
            resetStatus = true;
        }
        const status = options.nodeElement?.querySelector?.('.node-generation-status');
        const removedStatus = status?.textContent === '正在提交生成请求';
        if (removedStatus) status.remove?.();
        return { resetStatus, removedStatus };
    }

    async function runGuardedGenerationResponse(options) {
        let cleanup = { stale: false };
        try {
            const result = await options.response;
            const stale = !generationContextMatches(options.captured, options.current());
            cleanup = { stale, result };
            if (stale) {
                return { stale: true, result };
            }
            const value = await options.onSuccess?.(result);
            return { stale: false, result, value };
        } catch (error) {
            const stale = !generationContextMatches(options.captured, options.current());
            cleanup = { stale, error };
            if (stale) {
                return { stale: true, error };
            }
            const value = await options.onError?.(error);
            if (!options.onError) throw error;
            return { stale: false, error, value };
        } finally {
            await options.onFinally?.(cleanup);
        }
    }

    function referenceRole(mode, index) {
        if (mode === 'first-last-frame-video') return index === 0 ? '首帧' : index === 1 ? '尾帧' : `参考图 ${index + 1}`;
        if (mode === 'first-frame-video' || mode === 'first-frame-draft') return index === 0 ? '首帧' : `参考图 ${index + 1}`;
        if (mode === 'last-frame-draft') return index === 0 ? '尾帧' : `参考图 ${index + 1}`;
        return `参考图 ${index + 1}`;
    }

    function replaceCameraLine(prompt, cameraText) {
        const base = typeof prompt === 'string' ? prompt : '';
        const camera = typeof cameraText === 'string' ? cameraText.trim() : '';
        if (!camera) return base;
        const lines = base.split('\n');
        const index = lines.findIndex(line => /^\s*运镜：/.test(line));
        if (index >= 0) lines[index] = `运镜：${camera}`;
        else lines.push(`运镜：${camera}`);
        return lines.join('\n');
    }

    function sanitizeSerializable(value) {
        if (typeof value === 'string') return /^(blob:|data:)/i.test(value) ? '' : value;
        if (Array.isArray(value)) return value.map(sanitizeSerializable);
        if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
            return Object.keys(value).reduce((result, key) => {
                result[key] = sanitizeSerializable(value[key]);
                return result;
            }, {});
        }
        return value;
    }

    function durableCanvasDocument(payload) {
        const clone = typeof structuredClone === 'function'
            ? structuredClone(payload)
            : JSON.parse(JSON.stringify(payload));
        return sanitizeSerializable(clone);
    }

    function applyGenerationQuickAction(dependencies, action) {
        const startsReferenceSelection = Number(action?.referenceCount || 0) < Number(action?.minimumReferences || 0);
        dependencies.selectNode(action.nodeId);
        dependencies.configureMode(action.nodeId, action.mode);
        dependencies.renderControls(action.nodeId);
        if (startsReferenceSelection) dependencies.startReferenceSelection(action.nodeId);
        dependencies.scheduleSave(`${action.nodeType}_quick_mode`);
        return { startsReferenceSelection };
    }

    function updateGenerationResultRegion(nodeElement, html) {
        const resultRegion = nodeElement?.querySelector?.('[data-generation-result-region]');
        if (!resultRegion) return false;
        resultRegion.innerHTML = html;
        return true;
    }

    function applyDownstreamVideoAction(dependencies, action) {
        if (typeof dependencies?.createVideoNode !== 'function'
            || typeof dependencies?.connectNodes !== 'function'
            || typeof dependencies?.rollbackVideoNode !== 'function') return null;
        const videoNodeId = dependencies.createVideoNode();
        if (!videoNodeId) return null;
        let connected = false;
        try {
            connected = dependencies.connectNodes(action.sourceNodeId, videoNodeId) === true;
        } catch {
            connected = false;
        }
        if (connected) return videoNodeId;
        try {
            dependencies.rollbackVideoNode(videoNodeId);
        } catch {
            // Connection failure remains the primary outcome even if rollback cleanup fails.
        }
        return null;
    }

    function pollDelay(attempt, errorCount, hidden) {
        if (hidden) return 15000;
        if (errorCount > 0) return Math.min(20000, errorCount * 5000);
        if (attempt <= 1) return 3000;
        if (attempt <= 3) return 5000;
        return 8000;
    }

    function clearVideoEstimateEntries(entries, clearTimer) {
        if (!entries || typeof entries.values !== 'function') return;
        try {
            for (const entry of entries.values()) {
                if (entry?.timer != null && typeof clearTimer === 'function') {
                    try {
                        clearTimer(entry.timer);
                    } catch {
                        // Continue releasing the remaining transient entries.
                    }
                }
                if (typeof entry?.controller?.abort === 'function') {
                    try {
                        entry.controller.abort();
                    } catch {
                        // A failed abort must not retain the old context map.
                    }
                }
            }
        } finally {
            entries.clear?.();
        }
    }

    return {
        generationNodeDimensions,
        generationNodeLongEdge,
        normalizeCapabilities,
        videoTaskActionAvailability,
        modeOptions,
        isNonterminalGenerationStatus,
        nodeHasNonterminalVideoTask,
        generationInteractionReadiness,
        createGenerationSubmissionTracker,
        recoverTasklessNonterminalVideoNode,
        referenceIdsFromNodeData,
        availableReferenceCount,
        captureGenerationContext,
        generationContextMatches,
        cleanupGenerationSubmission,
        runGuardedGenerationResponse,
        referenceRole,
        replaceCameraLine,
        sanitizeSerializable,
        durableCanvasDocument,
        applyGenerationQuickAction,
        updateGenerationResultRegion,
        applyDownstreamVideoAction,
        pollDelay,
        clearVideoEstimateEntries
    };
});
