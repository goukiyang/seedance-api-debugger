(function (root) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const LABELS = { accepts_requirement: '本次需求', handoff: '交接成果', guidance: '指导协作', review: '请对方检查' };
    const clone = value => JSON.parse(JSON.stringify(value));
    const uid = () => 'relation-' + crypto.randomUUID();

    // Search only the card-edge corridors. A missing route remains accessible in the list.
    function route(start, end, obstacles, lane) {
        const clear = (a, b) => !obstacles.some(r => a.x === b.x
            ? a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom
            : a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right);
        const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.left - lane, r.right + lane])])].sort((a, b) => a - b);
        const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.top - lane, r.bottom + lane])])].sort((a, b) => a - b);
        if (xs.length * ys.length > 4096) return null;
        const key = p => p.x + ':' + p.y;
        const queue = [{ p: start, points: [start], distance: 0 }], best = new Map([[key(start), 0]]);
        let visits = 0;
        while (queue.length && visits++ < 4096) {
            queue.sort((a, b) => a.distance - b.distance);
            const item = queue.shift(), p = item.p;
            if (p.x === end.x && p.y === end.y) return item.points;
            const xi = xs.indexOf(p.x), yi = ys.indexOf(p.y);
            const neighbors = [xs[xi - 1] === undefined ? null : { x: xs[xi - 1], y: p.y },
                xs[xi + 1] === undefined ? null : { x: xs[xi + 1], y: p.y },
                ys[yi - 1] === undefined ? null : { x: p.x, y: ys[yi - 1] },
                ys[yi + 1] === undefined ? null : { x: p.x, y: ys[yi + 1] }];
            for (const next of neighbors) {
                if (!next || !clear(p, next)) continue;
                const distance = item.distance + Math.abs(next.x - p.x) + Math.abs(next.y - p.y) + 6;
                if ((best.get(key(next)) ?? Infinity) <= distance) continue;
                best.set(key(next), distance); queue.push({ p: next, distance, points: [...item.points, next] });
            }
        }
        return null;
    }

    function roundedPath(points) {
        if (!points?.length) return '';
        const simplified = points.filter((p, i) => !i || i === points.length - 1
            || !((points[i - 1].x === p.x && points[i + 1].x === p.x) || (points[i - 1].y === p.y && points[i + 1].y === p.y)));
        let d = 'M ' + simplified[0].x + ' ' + simplified[0].y;
        for (let i = 1; i < simplified.length - 1; i++) {
            const a = simplified[i - 1], p = simplified[i], b = simplified[i + 1];
            const before = Math.min(10, Math.hypot(p.x - a.x, p.y - a.y) / 2), after = Math.min(10, Math.hypot(b.x - p.x, b.y - p.y) / 2);
            d += ' L ' + (p.x - Math.sign(p.x - a.x) * before) + ' ' + (p.y - Math.sign(p.y - a.y) * before);
            d += ' Q ' + p.x + ' ' + p.y + ' ' + (p.x + Math.sign(b.x - p.x) * after) + ' ' + (p.y + Math.sign(b.y - p.y) * after);
        }
        const last = simplified[simplified.length - 1];
        return d + ' L ' + last.x + ' ' + last.y;
    }

    function validate(flow, values) {
        const members = new Set(flow.nodeIds), ids = new Set(), pairs = new Set();
        for (const edge of values) {
            const pair = edge.from + ':' + edge.to + ':' + edge.type;
            if (!LABELS[edge.type] || !members.has(edge.to) || edge.from === edge.to
                || (edge.type === 'accepts_requirement' ? edge.from !== 'requirement' : !members.has(edge.from))) throw new Error('只能连接同一工作流内的不同岗位。');
            if (ids.has(edge.id) || pairs.has(pair)) throw new Error('相同用途的关系已存在。');
            ids.add(edge.id); pairs.add(pair);
        }
        const visiting = new Set(), visited = new Set();
        function visit(id) {
            if (visiting.has(id)) throw new Error('必交材料会互相等待，请调整交接方向。');
            if (visited.has(id)) return;
            visiting.add(id); values.filter(e => e.to === id && e.type === 'handoff' && e.required).forEach(e => visit(e.from));
            visiting.delete(id); visited.add(id);
        }
        members.forEach(visit);
    }

    function create(options) {
        const engine = options.engine;
        if (!engine?.svg) return null;
        const layer = document.createElementNS(NS, 'g'); layer.classList.add('role-relation-layer');
        const marker = document.createElementNS(NS, 'marker'); marker.id = 'role-relation-arrow';
        marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto');
        const arrow = document.createElementNS(NS, 'path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); arrow.setAttribute('fill', 'context-stroke');
        marker.append(arrow); engine.svg.prepend(marker, layer);
        let mode = 'related', selected = '', source = null, menu = null, pending = null, frame = null, undo = null;
        let pointer = null, lastContext = '', lastAnchor = null;
        const contextKey = () => { const c = options.context(); return [c.userId, c.documentId, c.contextEpoch].join('|'); };
        const element = id => engine.canvas.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
        const flowFor = id => engine.nodes.get(id)?.type === 'role-requirement'
            ? (engine.roleWorkflows || []).find(f => f.id === engine.nodes.get(id).data?.roleRequirement?.workflowId)
            : (engine.roleWorkflows || []).find(f => f.nodeIds.includes(id));
        const configuration = flow => Array.isArray(flow.relations) ? flow.relations : options.legacyRelations?.(flow) || [];
        function label(id) { return id === 'requirement' ? '本次需求' : engine.nodes.get(id)?.data?.roleConfig?.snapshot?.name || engine.nodes.get(id)?.data?.title || '岗位已移除'; }
        function rect(id) {
            const node = engine.nodes.get(id), card = element(id); if (!node || !card) return null;
            return { left: node.x - 14, top: node.y - 14, right: node.x + card.offsetWidth + 14, bottom: node.y + card.offsetHeight + 14 };
        }
        function svg(tag, attributes) {
            const value = document.createElementNS(NS, tag); Object.entries(attributes).forEach(([key, text]) => value.setAttribute(key, text)); return value;
        }
        function render() {
            frame = null;
            if (lastContext !== contextKey()) { cancel(); undo = null; selected = ''; lastContext = contextKey(); }
            if (!layer.isConnected) engine.svg.prepend(layer);
            layer.replaceChildren();
            const current = engine.selectedNodeId;
            const obstacles = [...engine.nodes.keys()].map(rect).filter(Boolean);
            for (const flow of engine.roleWorkflows || []) {
                const requirements = [...engine.nodes.values()].filter(node => node.type === 'role-requirement'
                    && node.data?.roleRequirement?.workflowId === flow.id && (node.data?.roleRequirement?.runId || '') === options.runId());
                const requirement = requirements.find(node => node.id === options.requirementId?.()) || requirements[0];
                const pairs = new Map();
                for (const edge of flow.relations || []) {
                    const fromId = edge.from === 'requirement' ? requirement?.id : edge.from;
                    const from = rect(fromId), to = rect(edge.to); if (!from || !to) continue;
                    const related = mode === 'all' || current === fromId || current === edge.to || options.activeNodes?.().includes(edge.to);
                    const pair = fromId + ':' + edge.to, lane = 6 + (pairs.get(pair) || 0) * 8; pairs.set(pair, (pairs.get(pair) || 0) + 1);
                    const start = { x: from.right, y: (from.top + from.bottom) / 2 + lane }, end = { x: to.left, y: (to.top + to.bottom) / 2 + lane };
                    const points = route(start, end, obstacles, lane); if (!points) continue;
                    const group = svg('g', { class: 'role-relation' + (related ? ' related' : '') + (selected === edge.id ? ' selected' : ''),
                        'data-role-relation-id': edge.id, 'data-workflow-id': flow.id });
                    const path = svg('path', { d: roundedPath(points), class: 'role-relation-path', 'marker-end': 'url(#role-relation-arrow)' });
                    const hit = svg('path', { d: roundedPath(points), class: 'role-relation-hit', tabindex: '0', role: 'button',
                        'aria-label': label(edge.from) + ' → ' + label(edge.to) + '，' + LABELS[edge.type] });
                    const title = svg('title', {}); title.textContent = hit.getAttribute('aria-label'); group.append(title, path, hit);
                    if (selected === edge.id) {
                        const width = LABELS[edge.type].length * 13 + 12;
                        const anchors = points.slice(1).map((p, i) => ({ x: (p.x + points[i].x) / 2 - width / 2, y: (p.y + points[i].y) / 2 - 8 }));
                        const spot = anchors.find(p => !obstacles.some(r => p.x < r.right && p.x + width > r.left && p.y > r.top && p.y - 16 < r.bottom));
                        if (spot) { const text = svg('text', { x: spot.x, y: spot.y, class: 'role-relation-label' }); text.textContent = LABELS[edge.type]; group.append(text); }
                    }
                    hit.addEventListener('click', event => { event.stopPropagation(); selected = edge.id; showDetails(flow, edge); schedule(); });
                    hit.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); selected = edge.id; showDetails(flow, edge); schedule(); } });
                    layer.append(group);
                }
            }
            if (source) {
                const r = rect(source.id); if (r) {
                    const end = pointer || { x: r.right + 70, y: (r.top + r.bottom) / 2 };
                    layer.append(svg('path', { d: 'M ' + r.right + ' ' + (r.top + r.bottom) / 2 + ' L ' + end.x + ' ' + end.y, class: 'role-relation-preview' }));
                }
            }
        }
        function schedule() { if (frame === null) frame = requestAnimationFrame(render); }
        function cancel() {
            if (pending) return;
            const restore = menu?.contains(document.activeElement);
            menu?.remove(); menu = null; source = null; pointer = null;
            if (restore) lastAnchor?.focus?.({ preventScroll: true });
            engine.canvas.querySelectorAll('.role-connection-candidate, .role-connection-source').forEach(card => card.classList.remove('role-connection-candidate', 'role-connection-source'));
            engine.container.classList.remove('role-connecting'); schedule();
        }
        function control(text, action) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', action); return b;
        }
        function popup(title, anchor) {
            lastAnchor = anchor?.querySelector('[data-role-relation-handle]') || document.activeElement;
            menu?.remove(); menu = document.createElement('section'); menu.className = 'role-relation-menu'; menu.setAttribute('role', 'dialog');
            menu.setAttribute('aria-label', title); const heading = document.createElement('strong'); heading.textContent = title; menu.append(heading);
            const close = control('取消', cancel); close.className = 'role-relation-cancel'; menu.append(close);
            const box = anchor?.getBoundingClientRect(); menu.style.left = Math.max(12, Math.min(innerWidth - 300, box?.right || innerWidth / 2)) + 'px';
            menu.style.top = Math.max(60, Math.min(innerHeight - 330, box?.bottom || innerHeight / 2)) + 'px';
            document.body.append(menu); queueMicrotask(() => menu?.querySelector('button')?.focus()); return menu;
        }
        async function save(flow, values, host) {
            if (pending) return;
            const context = contextKey(), previous = clone(configuration(flow)); validate(flow, values);
            if (options.context().writable === false) throw new Error('当前画布不可编辑。');
            pending = true; host.querySelectorAll('button,input,select,textarea').forEach(b => { b.disabled = true; });
            try {
                await options.save(flow.id, values);
                if (context !== contextKey()) return;
                undo = { workflowId: flow.id, previous, saved: clone(values) };
                pending = null; cancel(); options.notice('关系已保存，下次任务生效；当前任务与历史未改变。', 'success');
            } catch (error) {
                if (context !== contextKey()) return;
                const message = host.querySelector('[role="status"]') || document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = error.message; host.append(message);
            } finally {
                pending = null;
                if (context === contextKey()) host.querySelectorAll('button,input,select,textarea').forEach(b => { b.disabled = false; });
                else { cancel(); undo = null; selected = ''; }
                schedule();
            }
        }
        function showDetails(flow, edge) {
            cancel(); selected = edge.id;
            const host = popup(label(edge.from) + ' → ' + label(edge.to), element(edge.to));
            const kind = document.createElement('p'); kind.textContent = LABELS[edge.type] + ' · 下次任务生效'; host.append(kind);
            const itemsLabel = document.createElement('label'); itemsLabel.textContent = '交付项（每行一项）';
            const items = document.createElement('textarea'); items.value = edge.items.join('\n'); items.maxLength = 4800; itemsLabel.append(items); host.append(itemsLabel);
            const required = document.createElement('input'); required.type = 'checkbox'; required.checked = edge.required;
            if (edge.type === 'handoff') { const l = document.createElement('label'); l.append(required, document.createTextNode(' 必须收到才能继续')); host.append(l); }
            const authority = document.createElement('select');
            for (const [value, name] of [['suggestion', '仅提供建议'], ['approve', '允许角色检查通过或退回']]) { const o = document.createElement('option'); o.value = value; o.textContent = name; authority.append(o); }
            authority.value = edge.authority; if (edge.type === 'review') { authority.setAttribute('aria-label', '检查权限'); host.append(authority); }
            const stage = document.createElement('p'); stage.textContent = '只采用有效稿；断开不撤销已有稿件、调用或审核。'; host.append(stage);
            host.append(control('保存关系', () => { const next = { ...edge, items: [...new Set(items.value.split('\n').map(v => v.trim()).filter(Boolean))],
                required: edge.type === 'handoff' && required.checked, authority: edge.type === 'review' ? authority.value : 'suggestion', stage: 'effective' };
                void save(flow, flow.relations.map(r => r.id === edge.id ? next : r), host).catch(error => options.notice(error.message, 'warning')); }),
            control('断开关系', () => { void save(flow, flow.relations.filter(r => r.id !== edge.id), host).catch(error => options.notice(error.message, 'warning')); }));
        }
        function begin(id) {
            if (pending || menu || options.context().writable === false) return;
            const flow = flowFor(id); if (!flow) return options.notice('请在工作流内配置协作关系。', 'warning');
            source = { id, flowId: flow.id, context: contextKey() }; engine.container.classList.add('role-connecting'); element(id)?.classList.add('role-connection-source'); schedule();
        }
        function target(id) {
            if (!source || menu || source.context !== contextKey()) return;
            const flow = flowFor(id); if (!flow || flow.id !== source.flowId || id === source.id || engine.nodes.get(id)?.type !== 'role') return options.notice('请选择同一工作流中的另一个岗位。', 'warning');
            const from = engine.nodes.get(source.id)?.type === 'role-requirement' ? 'requirement' : source.id;
            const host = popup(label(from) + ' → ' + label(id), element(id));
            const types = from === 'requirement' ? ['accepts_requirement'] : ['handoff', 'guidance', 'review'];
            const note = document.createElement('p'); note.textContent = '下次任务生效，保存关系不会开始工作。'; host.append(note);
            types.forEach(type => {
                const edge = { id: uid(), type, from, to: id, required: type === 'handoff', items: [], stage: 'effective', authority: 'suggestion' };
                host.append(control(LABELS[type], () => {
                    void save(flow, [...configuration(flow), edge], host).catch(error => options.notice(error.message, 'warning'));
                }));
            });
        }
        engine.container.addEventListener('pointerdown', event => {
            if (menu) { if (!event.target.closest('.role-relation-menu')) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
            const handle = event.target.closest('[data-role-relation-handle]');
            if (handle && event.button === 0) { event.preventDefault(); event.stopPropagation(); begin(handle.dataset.roleRelationHandle); pointer = null; }
            else if (source) { const card = event.target.closest('.canvas-node'); if (card) { event.preventDefault(); event.stopPropagation(); target(card.dataset.nodeId); } else cancel(); }
        }, true);
        engine.container.addEventListener('mousedown', event => { if (source || menu) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
        document.addEventListener('pointermove', event => {
            if (!source || menu) return;
            const box = engine.container.getBoundingClientRect(); pointer = { x: (event.clientX - box.left - engine.offsetX) / engine.scale, y: (event.clientY - box.top - engine.offsetY) / engine.scale };
            engine.canvas.querySelectorAll('.role-connection-candidate').forEach(card => card.classList.remove('role-connection-candidate'));
            const card = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node-type-role');
            if (card && card.dataset.nodeId !== source.id && flowFor(card.dataset.nodeId)?.id === source.flowId) card.classList.add('role-connection-candidate');
            schedule();
        });
        document.addEventListener('pointerup', event => {
            if (!source || menu || !pointer) return;
            const card = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node-type-role');
            if (card && card.dataset.nodeId !== source.id) target(card.dataset.nodeId);
        });
        document.addEventListener('pointercancel', cancel);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && (source || menu)) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
            if (event.key === 'Tab' && menu) {
                const controls = [...menu.querySelectorAll('button,input,select,textarea')].filter(item => !item.disabled);
                if (!controls.length) { event.preventDefault(); return; }
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                return;
            }
            if (!['Enter', ' '].includes(event.key) || menu) return;
            const handle = event.target.closest('[data-role-relation-handle]'), card = event.target.closest('.node-type-role');
            if (handle) { event.preventDefault(); event.stopImmediatePropagation(); begin(handle.dataset.roleRelationHandle); }
            else if (source && card) { event.preventDefault(); event.stopImmediatePropagation(); target(card.dataset.nodeId); }
        }, true);
        document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) { cancel(); event.preventDefault(); event.stopPropagation(); } }, true);
        const observer = new MutationObserver(schedule); observer.observe(engine.canvas, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        schedule();
        return { render: schedule, cancel, setMode: value => { mode = value === 'all' ? 'all' : 'related'; schedule(); },
            hasPending: () => Boolean(source || menu || pending), edit: (flow, edge) => { showDetails(flow, edge); schedule(); },
            undo: async () => { if (!undo) return; const flow = (engine.roleWorkflows || []).find(f => f.id === undo.workflowId);
                if (!flow || JSON.stringify(flow.relations) !== JSON.stringify(undo.saved)) throw new Error('关系已继续变化，不能覆盖后续修改。');
                const old = undo; await options.save(flow.id, old.previous); undo = null; schedule(); },
            destroy: () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); layer.remove(); marker.remove(); menu?.remove(); } };
    }
    root.UltimateCanvasRoleRouting = { create, validate, route };
})(typeof window !== 'undefined' ? window : globalThis);
