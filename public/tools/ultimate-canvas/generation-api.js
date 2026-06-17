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

    function mergeConfig(next = {}) {
        if (next.endpoints) state.endpoints = { ...state.endpoints, ...next.endpoints };
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
            const message = typeof data?.error === 'string'
                ? data.error
                : typeof data?.message === 'string'
                    ? data.message
                    : `Generation request failed: ${res.status}`;
            const err = new Error(message);
            err.response = data;
            throw err;
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
        const err = new Error(`${kindLabel}生成还没有可用的正式接口，请先完成后台能力配置和归属选择。`);
        err.response = {
            error: 'canvas_generation_endpoint_unavailable',
            kind: payload.kind || 'unknown',
            mode: payload.mode || '',
            message: err.message
        };
        return err;
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
