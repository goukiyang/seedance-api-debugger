(function () {
    'use strict';

    const state = {
        endpoints: {},
        headers: {},
        adapter: null
    };

    function makeId(prefix) {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function emit(name, detail) {
        window.dispatchEvent(new CustomEvent(`canvas-generation:${name}`, { detail }));
    }

    function capabilityPolicy(key) {
        const kind = String(key || '').split(':', 1)[0];
        return ['text', 'script', 'image', 'video'].includes(kind) ? kind : 'none';
    }

    function mergeConfig(next = {}) {
        if (next.endpoints) {
            const { resolveApiEndpoint } = window.UltimateCanvasBackendContract;
            const endpoints = Object.fromEntries(Object.entries(next.endpoints).map(([key, value]) => [
                key,
                resolveApiEndpoint(value, '', window.location.origin, capabilityPolicy(key))
            ]));
            state.endpoints = { ...state.endpoints, ...endpoints };
        }
        if (next.headers) state.headers = { ...state.headers, ...next.headers };
    }

    function endpointFor(payload) {
        const modeKey = payload.mode ? `${payload.kind}:${payload.mode}` : '';
        return state.endpoints[modeKey]
            || state.endpoints[payload.mode]
            || state.endpoints[payload.kind]
            || state.endpoints.default
            || '';
    }

    async function postJson(url, payload) {
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...state.headers
            },
            body: JSON.stringify(payload)
        });
        const text = await res.text();
        let data = text;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!res.ok) {
            throw window.UltimateCanvasBackendContract.createApiError(
                res.status,
                data,
                `Generation request failed: ${res.status}`
            );
        }
        return data;
    }

    function unavailableEndpointError(payload) {
        const kindLabel = payload.kind === 'image'
            ? '图片'
            : payload.kind === 'video'
                ? '视频'
                : payload.kind === 'script'
                    ? '脚本'
                    : '文本';
        const response = {
            error: 'canvas_generation_endpoint_unavailable',
            kind: payload.kind || 'unknown',
            mode: payload.mode || '',
            message: window.UltimateCanvasBackendContract.SAFE_UNAVAILABLE_MESSAGE,
            label: kindLabel
        };
        return window.UltimateCanvasBackendContract.createApiError(503, response);
    }

    async function generate(payload) {
        const request = {
            requestId: makeId('req'),
            createdAt: new Date().toISOString(),
            ...payload
        };

        emit('request', request);

        try {
            let result;
            if (state.adapter?.generate) {
                result = await state.adapter.generate(request);
            } else if (request.kind && state.adapter?.[request.kind]) {
                result = await state.adapter[request.kind](request);
            } else {
                const endpoint = endpointFor(request);
                if (!endpoint) throw unavailableEndpointError(request);
                result = await postJson(endpoint, request);
            }

            emit('result', { request, result });
            return result;
        } catch (error) {
            emit('error', {
                request,
                error: {
                    message: error.message,
                    response: error.response
                }
            });
            throw error;
        }
    }

    window.CanvasGenerationAPI = {
        configure: mergeConfig,
        setAdapter(adapter) {
            state.adapter = adapter || null;
        },
        generate,
        generateImage(payload) {
            return generate({ ...payload, kind: 'image' });
        },
        generateVideo(payload) {
            return generate({ ...payload, kind: 'video' });
        },
        textToVideo(payload) {
            return generate({ ...payload, kind: 'video', mode: 'text-to-video' });
        },
        imageToVideo(payload) {
            return generate({ ...payload, kind: 'video', mode: 'image-to-video' });
        },
        upscaleImage(payload) {
            return generate({ ...payload, kind: 'image', mode: 'upscale-image' });
        },
        ping() {
            return {
                ready: true,
                endpoints: { ...state.endpoints },
                hasAdapter: Boolean(state.adapter)
            };
        }
    };
}());
