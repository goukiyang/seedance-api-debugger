(function (root) {
    'use strict';
    const ENDPOINT = '/api/tools/ultimate-canvas/quote';
    const DEBOUNCE_MS = 500;
    const MAX_WAIT_MS = 500;
    const MAX_NODES = 128;
    const MAX_CONCURRENT = 4;
    let mounted = null;
    const validCredits = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000000
        && Math.abs(value * 100 - Math.round(value * 100)) <= Math.min(0.00001, Number.EPSILON * Math.max(1, value * 100) * 4);
    const formatCredits = value => validCredits(value) ? String(Math.round(value * 100) / 100) : '待确认';
    const fullQuoteRequired = quote => quote?.actualQuoteRequired === true || quote?.pricingQuoteRequired === true;
    function validFullQuote(quote, projection, now = Date.now()) {
        return validCredits(quote?.estimatedCredits) && validCredits(quote?.unitCredits)
            && (quote.creditPrecision !== 0.1 || Math.round(quote.unitCredits * 100) % 10 === 0 && Math.round(quote.estimatedCredits * 100) % 10 === 0)
            && typeof quote?.billingQuoteId === 'string' && quote.billingQuoteId.length > 0
            && Date.parse(quote.expiresAt) > now && quote.revision === projection?.revision
            && (quote.billingMode === 'actual' && quote.actualChargeEnabled === true || quote.billingMode === 'fixed'
                && typeof quote.pricingRevision === 'string' && quote.pricingRevision.length > 0)
            && (!projection?.pricingRevision || projection.pricingRevision === quote.pricingRevision);
    }

    function mount({ requestJson, getNodeSettings, getProjectId, getBootstrap,
        getQuoteSnapshot = () => '', onActualQuoteRequired = null, onQuoteInvalidated = null }) {
        if (![requestJson, getNodeSettings, getProjectId, getBootstrap].every(fn => typeof fn === 'function')) {
            throw new TypeError('Node pricing requires requestJson, getNodeSettings, getProjectId and getBootstrap.');
        }
        if (mounted) mounted.dispose();
        const states = new Map();
        let active = 0;
        let stopped = false;

        function inputFor(node) {
            const settings = getNodeSettings(node) || {};
            const capability = getBootstrap()?.capabilities?.image || {};
            const payload = {
                kind: 'image', project_id: getProjectId() || '',
                model: settings.model || capability.model || '', count: settings.count
            };
            if (typeof settings.channelId === 'string' && settings.channelId) payload.channelId = settings.channelId;
            for (const key of ['resolution', 'ratio', 'size', 'quality']) {
                if (typeof settings[key] === 'string') payload[key] = settings[key];
            }
            const nodeEl = states.get(String(node.id))?.el;
            const prompt = nodeEl?.querySelector('.image-props-textarea')?.value ?? node.data?.prompt ?? '';
            return { payload, expectedChannelId: settings.effectiveChannelId || settings.channelId, key: JSON.stringify([payload, settings, capability, node.data?.mode || '', prompt,
                getQuoteSnapshot(node.id)]) };
        }

        function usable(state) {
            return !stopped && states.get(state.id) === state && state.el.isConnected
                && state.node.type === 'image' && state.el.querySelector('[data-generation-image-model]');
        }

        function currentQuote(nodeId) {
            const state = states.get(String(nodeId));
            if (!state || !usable(state) || state.validUntil <= Date.now() || !state.quote
                || !state.key || inputFor(state.node).key !== state.key) return null;
            const quote = state.quote;
            if (quote.kind !== 'image' || quote.projectId !== state.payload.project_id
                || quote.model !== state.payload.model || quote.count !== state.payload.count
                || quote.status !== 'estimate' || quote.chargeEnabled !== false
                || quote.actualQuoteRequired !== false
                || !validCredits(quote.estimatedCredits)
                || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) return null;
            if (state.payload.channelId) {
                const channel = quote.imageChannel;
                if (channel?.channelId !== inputFor(state.node).expectedChannelId
                    || typeof channel.configRevision !== 'string' || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)) return null;
            }
            return quote;
        }

        function paintPrice(state) {
            const style = state.node.data?.canvasStyle;
            let slot = style
                ? state.el.querySelector('[data-style-price]')
                : state.el.querySelector('[data-canvas-node-price]');
            if (!slot) {
                const editor = state.el.querySelector('[data-generation-editor="image"]');
                const footer = editor?.querySelector('.generation-editor-footer');
                if (!editor || !footer) return;
                slot = document.createElement('div');
                slot.className = 'canvas-node-price-slot';
                slot.dataset.canvasNodePrice = '';
                slot.setAttribute('role', 'status');
                slot.setAttribute('aria-live', 'polite');
                slot.textContent = '费用待估算';
                footer.after(slot);
            }
            const credits = fullQuoteRequired(state.quote)
                ? validFullQuote(state.actualQuote, state.quote) ? state.actualQuote.estimatedCredits : null
                : currentQuote(state.id)?.estimatedCredits;
            slot.textContent = validCredits(credits) ? `合计约 ${formatCredits(credits)} 点数` : '费用待估算';
        }

        function paint(state) {
            if (!usable(state)) return;
            paintPrice(state);
            const select = state.el.querySelector('[data-generation-image-model]');
            const line = select.closest('.video-model-info');
            if (!line) return;
            paintModelMenu(state, select, line);
        }

        function paintModelMenu(state, select, line) {
            if (!state.menu || state.select !== select) {
                state.menu?.remove();
                state.trigger?.remove();
                state.select = select;
                select.hidden = true;
                const trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'canvas-model-trigger';
                trigger.setAttribute('aria-haspopup', 'menu');
                trigger.setAttribute('aria-expanded', 'false');
                const label = document.createElement('span');
                const arrow = document.createElement('i');
                arrow.textContent = '⌄';
                arrow.setAttribute('aria-hidden', 'true');
                trigger.append(label, arrow);
                const menu = document.createElement('div');
                menu.className = 'canvas-model-menu';
                menu.id = `canvas-model-menu-${state.id}`;
                menu.setAttribute('popover', 'auto');
                menu.setAttribute('role', 'menu');
                menu.setAttribute('aria-label', '生成图片模型');
                trigger.setAttribute('aria-controls', menu.id);
                for (const type of ['pointerdown', 'mousedown']) {
                    trigger.addEventListener(type, event => event.stopPropagation());
                    menu.addEventListener(type, event => event.stopPropagation());
                }
                trigger.addEventListener('click', event => {
                    event.stopPropagation();
                    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
                    refresh(state.el, state.node);
                    const rect = trigger.getBoundingClientRect();
                    menu.style.width = `${Math.min(340, window.innerWidth - 16)}px`;
                    menu.showPopover();
                    const box = menu.getBoundingClientRect();
                    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`;
                    menu.style.top = `${Math.max(8, Math.min(rect.top - box.height - 6, window.innerHeight - box.height - 8))}px`;
                    menu.querySelector('[aria-checked="true"]')?.focus();
                });
                menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
                menu.addEventListener('keydown', event => {
                    const rows = [...menu.querySelectorAll('button:not(:disabled)')];
                    const index = rows.indexOf(document.activeElement);
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
                    rows[next]?.focus();
                });
                line.appendChild(trigger);
                document.body.appendChild(menu);
                state.trigger = trigger;
                state.menu = menu;
            }
            line.classList.add('has-canvas-node-price');
            state.trigger.firstChild.textContent = select.selectedOptions[0]?.textContent || '选择模型';
            state.trigger.disabled = select.disabled;
            const options = [...select.options];
            if (state.menu.dataset.options !== JSON.stringify(options.map(option => option.value))) {
                state.menu.replaceChildren();
                state.menu.dataset.options = JSON.stringify(options.map(option => option.value));
                for (const option of options) {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.setAttribute('role', 'menuitemradio');
                    row.dataset.model = option.value;
                    row.append(document.createElement('span'));
                    row.addEventListener('click', event => {
                        event.stopPropagation();
                        select.value = row.dataset.model;
                        state.menu.hidePopover();
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        state.trigger?.focus();
                    });
                    state.menu.appendChild(row);
                }
            }
            options.forEach((option, index) => {
                const row = state.menu.children[index];
                row.firstChild.textContent = option.textContent;
                row.disabled = option.disabled || !option.value;
                row.setAttribute('aria-checked', String(option.selected));
            });
        }


        function cancel(state) {
            clearTimeout(state.timer);
            clearTimeout(state.expiryTimer);
            clearTimeout(state.actualQuoteTimer);
            state.timer = null;
            state.actualQuoteTimer = null;
            state.ready = false;
            state.version += 1;
            state.controller?.abort();
            state.controller = null;
        }

        function dispose(nodeId) {
            if (nodeId === undefined) {
                stopped = true;
                document.removeEventListener('input', onPromptInput);
                document.removeEventListener('visibilitychange', onVisibility);
                for (const id of Array.from(states.keys())) dispose(id);
                return;
            }
            const state = states.get(String(nodeId));
            if (!state) return;
            onQuoteInvalidated?.(state.node.id);
            cancel(state);
            state.menu?.remove();
            state.trigger?.remove();
            if (state.select) state.select.hidden = false;
            state.el.querySelector('.canvas-node-price-slot')?.remove();
            state.el.querySelector('.has-canvas-node-price')?.classList.remove('has-canvas-node-price');
            states.delete(state.id);
        }

        function drain() {
            if (stopped || document.hidden) return;
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
                const timeout = setTimeout(() => controller.abort(), 30000);
                Promise.resolve().then(() => requestJson(ENDPOINT, {
                    method: 'POST', payload, cache: 'no-store', signal: controller.signal
                })).then(async quote => {
                    if (!usable(state) || state.version !== version || controller.signal.aborted
                        || inputFor(state.node).key !== key) return;
                    if (quote?.kind !== 'image' || quote.projectId !== state.payload.project_id
                        || quote.model !== state.payload.model || quote.count !== state.payload.count
                        || (state.payload.channelId && (quote.imageChannel?.channelId !== inputFor(state.node).expectedChannelId
                            || typeof quote.imageChannel?.configRevision !== 'string' || !quote.imageChannel.configRevision))
                        || quote.chargeEnabled !== false || !['estimate', 'unavailable'].includes(quote.status)
                        || typeof quote.actualQuoteRequired !== 'boolean'
                        || (quote.actualQuoteRequired && (quote.unitCredits !== null || quote.estimatedCredits !== null))
                        || !Number.isSafeInteger(quote.revision) || !Array.isArray(quote.modelOptions)
                        || quote.modelOptions.some(item => typeof item?.actualQuoteRequired !== 'boolean'
                            || (item.actualQuoteRequired && (item.unitCredits !== null || item.estimatedCredits !== null)))
                        || !Number.isFinite(Date.parse(quote.expiresAt))) {
                        throw new Error('Invalid estimate response');
                    }
                    state.quote = quote;
                    state.validUntil = Math.min(Date.parse(quote.expiresAt), Date.now() + 60000);
                    if (state.validUntil <= Date.now()) throw new Error('Expired estimate response');
                    paint(state);
                    if (fullQuoteRequired(quote) && quote.status === 'estimate' && onActualQuoteRequired) {
                        const actualQuote = await onActualQuoteRequired(state.node, quote);
                        if (!usable(state) || state.version !== version || inputFor(state.node).key !== key) return;
                        const actualExpiry = Date.parse(actualQuote?.expiresAt);
                        if (validFullQuote(actualQuote, quote)) {
                            state.actualQuote = actualQuote;
                            state.actualQuoteTimer = setTimeout(() => {
                                if (state.version !== version) return;
                                state.actualQuote = null;
                                onQuoteInvalidated?.(state.node.id);
                                paint(state);
                            }, Math.max(0, actualExpiry - Date.now()));
                            paint(state);
                        }
                    }
                    state.expiryTimer = setTimeout(() => {
                        if (!usable(state)) { dispose(state.id); return; }
                        if (state.version !== version) return;
                        state.quote = null;
                        state.actualQuote = null;
                        state.validUntil = 0;
                        state.message = '报价已过期';
                        onQuoteInvalidated?.(state.node.id);
                        paint(state);
                        if (!document.hidden) refresh(state.el, state.node);
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
            if (state.key && state.key !== input.key) {
                state.actualQuote = null;
                clearTimeout(state.actualQuoteTimer);
                state.actualQuoteTimer = null;
                onQuoteInvalidated?.(state.node.id);
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
            state.queuedAt = Date.now();
            state.timer = setTimeout(() => {
                state.timer = null;
                state.ready = true;
                drain();
            }, Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (Date.now() - state.queuedAt))));
        }

        function onPromptInput(event) {
            const input = event.target;
            if (!input?.matches?.('.image-props-textarea')) return;
            const nodeEl = input.closest('[data-node-id]');
            const node = window.canvasEngine?.nodes?.get(nodeEl?.dataset.nodeId);
            if (node) refresh(nodeEl, node);
        }

        document.addEventListener('input', onPromptInput);
        function onVisibility() {
            if (document.hidden) return;
            for (const state of states.values()) refresh(state.el, state.node);
            drain();
        }
        document.addEventListener('visibilitychange', onVisibility);
        mounted = {
            refresh,
            dispose,
            actualQuoteRequired(nodeId) {
                const quote = states.get(String(nodeId))?.quote;
                return typeof quote?.actualQuoteRequired === 'boolean' ? fullQuoteRequired(quote) : null;
            },
            imageChannel(nodeId) {
                const state = states.get(String(nodeId));
                if (!state || state.validUntil <= Date.now() || !state.payload.channelId
                    || state.quote?.imageChannel?.channelId !== inputFor(state.node).expectedChannelId
                    || typeof state.quote?.imageChannel?.configRevision !== 'string') return null;
                return state.quote.imageChannel;
            },
            actualQuote(nodeId) {
                const quote = states.get(String(nodeId))?.actualQuote;
                return Date.parse(quote?.expiresAt) > Date.now() ? quote : null;
            },
            quote(nodeId) {
                return currentQuote(nodeId);
            },
            clearActualQuote(nodeId) {
                const state = states.get(String(nodeId));
                if (!state) return;
                state.actualQuote = null;
                clearTimeout(state.actualQuoteTimer);
                state.actualQuoteTimer = null;
                paint(state);
            },
            invalidateProjection(nodeId) {
                const state = states.get(String(nodeId));
                if (!state) return;
                onQuoteInvalidated?.(state.node.id);
                cancel(state);
                state.key = '';
                state.quote = null;
                state.actualQuote = null;
                state.validUntil = 0;
                state.queuedAt = 0;
                paint(state);
            }
        };
        return mounted;
    }

    root.UltimateCanvasNodePricing = {
        validCredits, formatCredits, fullQuoteRequired, validFullQuote,
        mount,
        refresh(nodeEl, node) { mounted?.refresh(nodeEl, node); },
        actualQuoteRequired(nodeId) { return mounted?.actualQuoteRequired(nodeId) ?? null; },
        imageChannel(nodeId) { return mounted?.imageChannel(nodeId) ?? null; },
        actualQuote(nodeId) { return mounted?.actualQuote(nodeId) ?? null; },
        quote(nodeId) { return mounted?.quote(nodeId) ?? null; },
        clearActualQuote(nodeId) { mounted?.clearActualQuote(nodeId); },
        invalidateProjection(nodeId) { mounted?.invalidateProjection(nodeId); },
        dispose(nodeId) { mounted?.dispose(nodeId); }
    };
})(window);
