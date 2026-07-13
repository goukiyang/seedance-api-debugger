(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasBackendContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_STATUS_TEMPLATE = '/api/video/status/:taskId?refresh=true';

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function resolveApiEndpoint(candidate, fallback, origin) {
        const safeFallback = clean(fallback);
        try {
            const base = new URL(clean(origin));
            const resolved = new URL(clean(candidate) || safeFallback, base);
            if (resolved.origin !== base.origin || !resolved.pathname.startsWith('/api/')) return safeFallback;
            return `${resolved.pathname}${resolved.search}`;
        } catch {
            return safeFallback;
        }
    }

    function resolveTaskStatusEndpoint(template, taskId, origin) {
        const encodedTaskId = encodeURIComponent(clean(taskId));
        const fallback = DEFAULT_STATUS_TEMPLATE.replace(':taskId', encodedTaskId);
        const candidate = (clean(template) || DEFAULT_STATUS_TEMPLATE).replace(':taskId', encodedTaskId);
        return resolveApiEndpoint(candidate, fallback, origin);
    }

    function backendStatus(bootstrap) {
        const mode = bootstrap?.backend?.mode === 'mock' ? 'mock' : 'sd2';
        return mode === 'mock'
            ? { mode, label: '本地 Mock', isReal: false }
            : { mode, label: 'SD2 真实后端', isReal: true };
    }

    function requestErrorMessage(status, payload) {
        const detail = clean(payload?.detail) || clean(payload?.message) || clean(payload?.error);
        if (status === 401) return '登录已失效，请重新登录后继续。';
        if (status === 403) return detail || '当前账号没有操作此项目或视频卡的权限。';
        return detail || `请求失败：${status}`;
    }

    return { resolveApiEndpoint, resolveTaskStatusEndpoint, backendStatus, requestErrorMessage };
});
