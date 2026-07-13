(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasBackendContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_STATUS_TEMPLATE = '/api/video/status/:taskId?refresh=true';
    const SAFE_UNAVAILABLE_MESSAGE = '该功能暂时不可用，请稍后重试。';
    const CAPABILITY_PATHS = Object.freeze({
        text: '/api/tools/ultimate-canvas/generate',
        script: '/api/tools/ultimate-canvas/generate',
        image: '/api/assets/generate',
        video: '/api/tasks/create'
    });
    const CANVAS_PATHS = [
        /^\/api\/tools\/ultimate-canvas\/(?:bootstrap|document|upload)$/,
        /^\/api\/assets\/library$/,
        /^\/api\/projects(?:\/[^/]+(?:\/video-cards)?)?$/,
        /^\/api\/video-cards\/[^/]+(?:\/branches(?:\/[^/]+)?|\/tasks|\/split|\/merge)?$/,
        /^\/api\/approvals$/,
        /^\/api\/video\/retry\/[^/]+$/,
        /^\/api\/tasks\/estimate$/
    ];

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function isAllowedEndpoint(url, policy) {
        if (url.hash || url.username || url.password) return false;
        if (Object.prototype.hasOwnProperty.call(CAPABILITY_PATHS, policy)) {
            return url.pathname === CAPABILITY_PATHS[policy] && !url.search;
        }
        if (policy === 'video-status') {
            return /^\/api\/video\/status\/[^/]+$/.test(url.pathname)
                && url.search === '?refresh=true';
        }
        if (policy !== 'canvas') return false;
        return CANVAS_PATHS.some(pattern => pattern.test(url.pathname));
    }

    function resolveAllowedEndpoint(value, base, policy) {
        const endpoint = clean(value);
        if (!endpoint) return '';
        try {
            const resolved = new URL(endpoint, base);
            if (resolved.origin !== base.origin || !isAllowedEndpoint(resolved, policy)) return '';
            return `${resolved.pathname}${resolved.search}`;
        } catch {
            return '';
        }
    }

    function resolveApiEndpoint(candidate, fallback, origin, policy = 'canvas') {
        try {
            const base = new URL(clean(origin));
            return resolveAllowedEndpoint(candidate, base, policy)
                || resolveAllowedEndpoint(fallback, base, policy);
        } catch {
            return '';
        }
    }

    function validStatusTemplate(template, origin) {
        const value = clean(template);
        if ((value.match(/:taskId/g) || []).length !== 1) return '';
        try {
            const base = new URL(clean(origin));
            const resolved = new URL(value, base);
            if (resolved.origin !== base.origin
                || resolved.pathname !== '/api/video/status/:taskId'
                || resolved.search !== '?refresh=true'
                || resolved.hash
                || resolved.username
                || resolved.password) return '';
            return `${resolved.pathname}${resolved.search}`;
        } catch {
            return '';
        }
    }

    function resolveTaskStatusEndpoint(template, taskId, origin) {
        const validatedDefault = validStatusTemplate(DEFAULT_STATUS_TEMPLATE, origin);
        if (!validatedDefault) return '';
        const validatedTemplate = validStatusTemplate(template, origin) || validatedDefault;
        const encodedTaskId = encodeURIComponent(clean(taskId));
        const fallback = validatedDefault.replace(':taskId', encodedTaskId);
        const candidate = validatedTemplate.replace(':taskId', encodedTaskId);
        return resolveApiEndpoint(candidate, fallback, origin, 'video-status');
    }

    function backendStatus(bootstrap) {
        const backend = bootstrap?.backend;
        if (backend?.mode === 'mock'
            && backend.transport === 'same-origin'
            && backend.mock === true) {
            return { mode: 'mock', label: '本地 Mock', isReal: false };
        }
        if (backend?.mode === 'sd2'
            && backend.transport === 'same-origin'
            && backend.mock === false) {
            return { mode: 'sd2', label: 'SD2 真实后端', isReal: true };
        }
        return { mode: 'unverified', label: '后端状态未验证', isReal: false };
    }

    function payloadText(payload) {
        try {
            return JSON.stringify(payload || {});
        } catch {
            return '';
        }
    }

    function containsConfigurationInstruction(value) {
        return /api\s*[_ -]?key|seedance_api_key|environment.{0,20}(?:variable|config|setup)|admin(?:istrator)?\s+api|provider.{0,40}config|config(?:uration)?(?:\s+is)?[_ -]?(?:missing|required|unavailable)|not\s+configured|configure.{0,40}(?:provider|admin|api)|环境.{0,20}(?:变量|设置|配置)|后台.{0,20}(?:api|设置|配置)|密钥|未配置|配置缺失|缺少.{0,20}(?:api|配置)|(?:供应商|服务商).{0,20}配置/i.test(value);
    }

    function requestErrorMessage(status, payload, fallbackMessage = '') {
        if (status === 401) return '登录已失效，请重新登录后继续。';
        const detail = clean(payload?.detail) || clean(payload?.message) || clean(payload?.error);
        if (containsConfigurationInstruction(`${payloadText(payload)} ${fallbackMessage}`)) {
            return SAFE_UNAVAILABLE_MESSAGE;
        }
        if (status === 403) return detail || '当前账号没有操作此项目或视频卡的权限。';
        return detail || clean(fallbackMessage) || `请求失败：${status}`;
    }

    function createApiError(status, payload, fallbackMessage = '') {
        const error = new Error(requestErrorMessage(status, payload, fallbackMessage));
        error.status = status;
        error.response = payload;
        return error;
    }

    return {
        SAFE_UNAVAILABLE_MESSAGE,
        resolveApiEndpoint,
        resolveTaskStatusEndpoint,
        backendStatus,
        requestErrorMessage,
        createApiError
    };
});
