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
    const DEFAULTS = Object.freeze({
        image: Object.freeze({ modes: MODE_DEFINITIONS.image.map(mode => mode.id), ratios: ['1:1', '4:3', '16:9', '9:16'], durations: [], resolutions: ['1K', '2K'], supportsAudio: false, supportsLastFrame: false, supportsWatermark: false, maxReferenceImages: 10 }),
        video: Object.freeze({ modes: MODE_DEFINITIONS.video.map(mode => mode.id), ratios: ['16:9', '9:16'], durations: [5, 10], resolutions: ['720p', '1080p'], supportsAudio: false, supportsLastFrame: false, supportsWatermark: true, maxReferenceImages: 9 })
    });

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

    function normalizeCapabilities(kind, capability) {
        const defaults = DEFAULTS[kind] || DEFAULTS.video;
        const interaction = isPlainObject(capability?.interaction) ? capability.interaction : {};
        const definitions = MODE_DEFINITIONS[kind] || MODE_DEFINITIONS.video;
        const validModes = new Set(definitions.map(mode => mode.id));
        const modes = strings(interaction.modes, value => validModes.has(value));
        const ratios = strings(interaction.ratios, value => VALID_RATIOS.has(value));
        const durations = (Array.isArray(interaction.durations) ? interaction.durations : []).filter(value => Number.isInteger(value) && value > 0);
        const validResolutions = kind === 'image' ? VALID_IMAGE_RESOLUTIONS : VALID_VIDEO_RESOLUTIONS;
        const resolutions = strings(interaction.resolutions, value => validResolutions.has(value));
        const maxReferenceImages = Number.isInteger(interaction.max_reference_images) && interaction.max_reference_images >= 0
            ? interaction.max_reference_images : defaults.maxReferenceImages;
        return {
            modes: modes.length ? modes : [...defaults.modes],
            ratios: ratios.length ? ratios : [...defaults.ratios],
            durations: durations.length ? [...new Set(durations)] : [...defaults.durations],
            resolutions: resolutions.length ? resolutions : [...defaults.resolutions],
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
            let reason = '';
            if (count < mode.minimumReferences) reason = `至少需要 ${mode.minimumReferences} 个参考图`;
            else if (count > mode.maximumReferences) reason = `最多支持 ${mode.maximumReferences} 个参考图`;
            return { ...mode, enabled: !reason, reason };
        });
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
        normalizeCapabilities,
        modeOptions,
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
