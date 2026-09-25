(function (root) {
    'use strict';
    const ENDPOINT = '/api/tools/ultimate-canvas/quote';
    const DEBOUNCE_MS = 250;
    const MAX_WAIT_MS = 1000;
    const MAX_NODES = 128;
    const MAX_CONCURRENT = 4;
    let mounted = null;

    function mount({ requestJson, getNodeSettings, getProjectId, getBootstrap }) {
        if (![requestJson, getNodeSettings, getProjectId, getBootstrap].every(fn => typeof fn === 'function')) {
            throw new TypeError('Node pricing requires requestJson, getNodeSettings, getProjectId and getBootstrap.');
        }
        if (mounted) mounted.dispose();
        const states = new Map();
        const labels = new WeakMap();
        let active = 0;
        let stopped = false;

        function inputFor(node) {
            const settings = getNodeSettings(node) || {};
            const capability = getBootstrap()?.capabilities?.image || {};
            const payload = {
                kind: 'image', project_id: getProjectId() || '',
                model: settings.model || capability.model || '', count: settings.count
            };
            for (const key of ['resolution', 'ratio', 'size', 'quality']) {
                if (typeof settings[key] === 'string') payload[key] = settings[key];
            }
            return { payload, key: JSON.stringify([payload, capability]) };
        }

        function usable(state) {
            return !stopped && states.get(state.id) === state && state.el.isConnected
                && state.node.type === 'image' && state.el.querySelector('[data-generation-image-model]');
        }

        function reasonText(reason) {
            return ({ provider_unavailable: '接口未配置', model_unavailable: '模型不可用',
                count_exceeds_limit: '张数超出限制', price_unconfigured: '未配置报价' })[reason] || '报价不可用';
        }

        function priceText(quote) {
            return quote?.status === 'estimate' && quote.chargeEnabled === false
                && Number.isFinite(quote.estimatedCredits) && quote.estimatedCredits >= 0
                ? `预估 ${quote.estimatedCredits} 积分` : reasonText(quote?.reason);
        }

        function writeText(el, text) {
            if (el.textContent !== text) el.textContent = text;
        }

        function paint(state) {
            if (!usable(state)) return;
            const select = state.el.querySelector('[data-generation-image-model]');
            const line = select.closest('.video-model-info');
            if (!line) return;
            let badge = line.querySelector('[data-canvas-node-price]');
            if (!badge) {
                // The wrapper keeps this span out of legacy span:nth-child(2) model selectors.
                const holder = document.createElement('div');
                holder.className = 'canvas-node-price-slot';
                badge = document.createElement('span');
                badge.dataset.canvasNodePrice = '';
                badge.tabIndex = 0;
                badge.setAttribute('role', 'button');
                badge.setAttribute('aria-label', '刷新当前节点报价');
                const refreshCurrent = event => {
                    event.stopPropagation();
                    if (usable(state)) refresh(state.el, state.node);
                };
                badge.addEventListener('click', refreshCurrent);
                badge.addEventListener('focus', refreshCurrent);
                badge.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    refreshCurrent(event);
                });
                // Keep activating the price from starting a canvas drag; preserve native focus.
                badge.addEventListener('pointerdown', event => event.stopPropagation());
                badge.addEventListener('mousedown', event => event.stopPropagation());
                holder.appendChild(badge);
                line.appendChild(holder);
            }
            if (!line.classList.contains('has-canvas-node-price')) line.classList.add('has-canvas-node-price');
            const quote = state.quote;
            const text = quote ? priceText(quote) : state.message;
            writeText(badge, text);
            const detail = quote?.status === 'estimate'
                ? `每张 ${quote.unitCredits} 积分 × ${quote.count} 张；仅为用量预估，不会从此处扣分。`
                : `${text}；不会从此处扣分。`;
            const title = `${detail} 点击或聚焦刷新过期报价。`;
            if (badge.title !== title) badge.title = title;
            for (const option of select.options) {
                let base = labels.get(option);
                if (base === undefined) {
                    const configured = getBootstrap()?.capabilities?.image?.model_options?.find(item => item.value === option.value);
                    base = configured?.label || option.textContent;
                    labels.set(option, base);
                }
                const item = quote?.modelOptions?.find(entry => entry.model === option.value);
                writeText(option, `${base} · ${item ? priceText(item) : quote ? '报价不可用' : state.message}`);
            }
        }

        function cancel(state) {
            clearTimeout(state.timer);
            clearTimeout(state.expiryTimer);
            state.timer = null;
            state.ready = false;
            state.version += 1;
            state.controller?.abort();
            state.controller = null;
        }

        function dispose(nodeId) {
            if (nodeId === undefined) {
                stopped = true;
                for (const id of Array.from(states.keys())) dispose(id);
                return;
            }
            const state = states.get(String(nodeId));
            if (!state) return;
            cancel(state);
            state.el.querySelector('.canvas-node-price-slot')?.remove();
            state.el.querySelector('.has-canvas-node-price')?.classList.remove('has-canvas-node-price');
            for (const option of state.el.querySelectorAll('[data-generation-image-model] option')) {
                if (labels.has(option)) writeText(option, labels.get(option));
            }
            states.delete(state.id);
        }

        function drain() {
            if (stopped) return;
            for (const state of states.values()) {
                if (!usable(state)) { dispose(state.id); continue; }
                if (active >= MAX_CONCURRENT) break;
                if (!state.ready) continue;
                state.ready = false;
                state.queuedAt = 0;
                const version = state.version;
                const key = state.key;
                const payload = state.payload;
                const controller = new AbortController();
                state.controller = controller;
                active += 1;
                const timeout = setTimeout(() => controller.abort(), 10000);
                Promise.resolve().then(() => requestJson(ENDPOINT, {
                    method: 'POST', payload, cache: 'no-store', signal: controller.signal
                })).then(quote => {
                    if (!usable(state) || state.version !== version || controller.signal.aborted
                        || inputFor(state.node).key !== key) return;
                    if (quote?.kind !== 'image' || quote.projectId !== state.payload.project_id
                        || quote.model !== state.payload.model || quote.count !== state.payload.count
                        || quote.chargeEnabled !== false || !['estimate', 'unavailable'].includes(quote.status)
                        || !Array.isArray(quote.modelOptions) || !Number.isFinite(Date.parse(quote.expiresAt))) {
                        throw new Error('Invalid estimate response');
                    }
                    state.quote = quote;
                    state.validUntil = Math.min(Date.parse(quote.expiresAt), Date.now() + 60000);
                    if (state.validUntil <= Date.now()) throw new Error('Expired estimate response');
                    paint(state);
                    state.expiryTimer = setTimeout(() => {
                        if (!usable(state)) { dispose(state.id); return; }
                        if (state.version !== version) return;
                        state.quote = null;
                        state.validUntil = 0;
                        state.message = '报价已过期';
                        paint(state);
                    }, Math.max(0, state.validUntil - Date.now()));
                }).catch(() => {
                    if (!usable(state) || state.version !== version || inputFor(state.node).key !== key) return;
                    state.quote = null;
                    state.message = '报价暂不可用';
                    state.validUntil = Date.now() + 10000;
                    paint(state);
                }).finally(() => {
                    clearTimeout(timeout);
                    if (state.controller === controller) state.controller = null;
                    active -= 1;
                    drain();
                });
            }
        }

        function refresh(nodeEl, node) {
            if (stopped || !node?.id) return;
            const id = String(node.id);
            if (node.type !== 'image' || !nodeEl?.isConnected
                || !nodeEl.querySelector('[data-generation-image-model]')) { dispose(id); return; }
            for (const [key, state] of states) if (!state.el.isConnected) dispose(key);
            let state = states.get(id);
            if (state && state.el !== nodeEl) { dispose(id); state = null; }
            if (!state) {
                if (states.size >= MAX_NODES) dispose(states.keys().next().value);
                state = { id, el: nodeEl, node, version: 0, key: '', quote: null, message: '待报价', validUntil: 0, queuedAt: 0 };
                states.set(id, state);
            }
            state.node = node;
            const input = inputFor(node);
            if (state.key === input.key && (state.timer || state.ready || state.controller || state.validUntil > Date.now())) {
                paint(state);
                return;
            }
            cancel(state);
            state.key = input.key;
            state.payload = input.payload;
            state.quote = null;
            state.validUntil = 0;
            const valid = input.payload.project_id && input.payload.model
                && Number.isInteger(input.payload.count) && input.payload.count >= 1 && input.payload.count <= 8;
            state.message = !input.payload.project_id ? '请先选择项目' : valid ? '待报价' : '参数未就绪';
            paint(state);
            if (!valid) { state.queuedAt = 0; return; }
            state.queuedAt = state.queuedAt || Date.now();
            state.timer = setTimeout(() => {
                state.timer = null;
                state.ready = true;
                drain();
            }, Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (Date.now() - state.queuedAt))));
        }

        mounted = { refresh, dispose };
        return mounted;
    }

    root.UltimateCanvasNodePricing = {
        mount,
        refresh(nodeEl, node) { mounted?.refresh(nodeEl, node); },
        dispose(nodeId) { mounted?.dispose(nodeId); }
    };
})(window);
