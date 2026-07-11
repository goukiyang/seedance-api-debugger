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
    const VALID_RESOLUTIONS = new Set(['480p', '720p', '1080p']);
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

    function normalizeCapabilities(kind, capability) {
        const defaults = DEFAULTS[kind] || DEFAULTS.video;
        const interaction = capability && typeof capability.interaction === 'object' ? capability.interaction : {};
        const definitions = MODE_DEFINITIONS[kind] || MODE_DEFINITIONS.video;
        const validModes = new Set(definitions.map(mode => mode.id));
        const modes = strings(interaction.modes, value => validModes.has(value));
        const ratios = strings(interaction.ratios, value => VALID_RATIOS.has(value));
        const durations = (Array.isArray(interaction.durations) ? interaction.durations : []).filter(value => Number.isInteger(value) && value > 0);
        const resolutions = strings(interaction.resolutions, value => typeof value === 'string' && value.trim().length > 0);
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

    function pollDelay(attempt, errorCount, hidden) {
        if (hidden) return 15000;
        if (errorCount > 0) return Math.min(20000, errorCount * 5000);
        if (attempt <= 1) return 3000;
        if (attempt <= 3) return 5000;
        return 8000;
    }

    return { normalizeCapabilities, modeOptions, referenceRole, replaceCameraLine, sanitizeSerializable, pollDelay };
});
