(function () {
    'use strict';
    const P = window.UltimateCanvasPlanSplit;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    window.UltimateCanvasPlanSplitUI = { create };
    function create(options) {
        const { engine } = options;
        let active = null, opening = false;
        const state = () => engine.planSplits ||= P.empty();
        function sourceText(nodeId) { return options.sourceText(nodeId); }
        function focus(ids, settings = {}) {
            const nodes = ids.map(id => engine.nodes.get(id)).filter(Boolean);
            if (!nodes.length) return options.notice('本批节点已删除；需要新节点时请明确创建副本。', 'warn');
            if (settings.includeControls) engine.selectNode(nodes[0].id);
            const bounds = nodes.reduce((box, node) => {
                const el = document.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]');
                let left = node.x, top = node.y;
                let right = node.x + (el?.offsetWidth || 640), bottom = node.y + (el?.offsetHeight || 480);
                if (settings.includeControls && el) {
                    const anchor = el.getBoundingClientRect(), scale = engine.scale || 1;
                    // Selected controls can extend outside the node's layout box.
                    for (const control of el.querySelectorAll('[data-generation-editor], .node-input-bar, .node-video-props, .generation-node-toolbar, [data-video-result-history]')) {
                        const rect = control.getBoundingClientRect();
                        if (!rect.width || !rect.height) continue;
                        left = Math.min(left, node.x + (rect.left - anchor.left) / scale);
                        top = Math.min(top, node.y + (rect.top - anchor.top) / scale);
                        right = Math.max(right, node.x + (rect.right - anchor.left) / scale);
                        bottom = Math.max(bottom, node.y + (rect.bottom - anchor.top) / scale);
                    }
                }
                box.left = Math.min(box.left, left); box.top = Math.min(box.top, top);
                box.right = Math.max(box.right, right); box.bottom = Math.max(box.bottom, bottom);
                return box;
            }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
            const rect = engine.container.getBoundingClientRect();
            engine.scale = Math.min(1, (rect.width - 80) / (bounds.right - bounds.left), (rect.height - 80) / (bounds.bottom - bounds.top));
            engine.scale = Math.max(.15, engine.scale);
            engine.offsetX = rect.width / 2 - (bounds.left + bounds.right) / 2 * engine.scale;
            engine.offsetY = rect.height / 2 - (bounds.top + bounds.bottom) / 2 * engine.scale;
            engine._applyTransform(); engine._updateZoom(); engine._updateConnections();
            if (!settings.includeControls) engine.selectNode(nodes[0].id);
        }
        function persist() {
            if (!active || !options.writable()) return;
            state().sources[active.source.id] = active.source;
            state().drafts[active.source.id] = active.draft;
            options.save('plan_split_draft');
            active.localSafe = options.cache() === true;
        }
        async function dismiss() {
            if (!active || active.busy) return;
            persist();
            if (active.changed && options.writable() && !await options.flush('plan_preview_close')) {
                active.message = '调整未保存到服务器；本地草稿仍保留，可稍后继续。';
                render();
                if (!active.localSafe) return;
            }
            active.layer.close();
            active = null;
        }
        async function open(nodeId, sourceId) {
            if (opening || active) return;
            opening = true;
            try {
                const node = engine.nodes.get(nodeId);
                const previous = sourceId ? state().sources[sourceId] : null;
                if (!previous && (!node || !['text', 'script', 'video'].includes(node.type))) return;
                const text = previous?.text ?? sourceText(nodeId);
                if (!text?.trim()) return options.notice('原文为空，请先填写完整方案。', 'warn');
                const hash = await P.revision(text);
                const source = previous || Object.values(state().sources).find(item => item.nodeId === nodeId && item.revision === hash)
                    || { id: P.uuid(), nodeId, revision: hash, version: P.VERSION, text };
                const draft = state().drafts[source.id] || P.parse(source);
                const settings = options.bindings(node);
                const previousDrafts = Object.values(state().sources).filter(item => item.nodeId === source.nodeId && item.id !== source.id && state().drafts[item.id]);
                active = { source, draft, settings, selected: sourceId ? 'original' : draft.view?.selected || draft.parts[0]?.id || '', changed: false, busy: false,
                    adjust: draft.view?.adjust === true, copy: false, localSafe: false, message: '', previousDrafts };
                active.layer = options.dialog({ className: 'canvas-plan-dialog', labelledBy: 'canvas-plan-title',
                    onDismiss: dismiss, content: '<div data-plan-root></div>' });
                render();
            } catch (error) { options.notice(error.message || '原文读取失败。', 'warn'); }
            finally { opening = false; }
        }
        function section(label, text) { return '<section><h3>' + label + '</h3><pre>' + esc(text) + '</pre></section>'; }
        function lineIndex(offset) { return P.lines(active.source.text).findIndex(row => row.end > offset) + 1; }
        function render() {
            if (!active) return;
            const a = active, part = a.draft.parts.find(item => item.id === a.selected);
            const text = part ? P.body(a.source, part) : a.source.text;
            const report = P.inspect(text, a.settings.settings, { boundary: part?.boundaryConfirmed, timeline: part?.timelineConfirmed });
            const chosen = a.draft.parts.filter(item => item.selected);
            const unresolved = a.draft.unassigned.filter(item => !item.excluded);
            const operation = state().operations[a.draft.operationId];
            const readOnly = !options.writable();
            const mustConfirm = chosen.some(item => !item.boundaryConfirmed);
            const root = a.layer.dialog.querySelector('[data-plan-root]');
            root.innerHTML = '<header class="canvas-plan-head"><h2 id="canvas-plan-title">拆分视频方案</h2><button type="button" data-plan-close class="plan-icon" aria-label="关闭" title="关闭">' + window.UltimateCanvasIcons('X') + '</button></header>'
                + (a.previousDrafts.length ? '<div class="plan-version">原文版本已变化，旧草稿保留。<select data-plan-version aria-label="原文版本"><option value="">当前原文</option>' + a.previousDrafts.map((item, index) => '<option value="' + esc(item.id) + '">旧草稿 ' + (index + 1) + '</option>').join('') + '</select></div>' : '')
                + '<div class="canvas-plan-grid"><aside aria-label="方案列表">' + (a.draft.parts.length ? a.draft.parts.map((item, index) => '<div class="plan-list-row ' + (item.id === a.selected ? 'active' : '') + '"><input type="checkbox" aria-label="创建方案 ' + (index + 1) + '" data-plan-check="' + esc(item.id) + '" ' + (item.selected ? 'checked ' : '') + (readOnly ? 'disabled' : '') + '><button type="button" data-plan-select="' + esc(item.id) + '">' + esc(item.title || '待确认方案 ' + (index + 1)) + (!item.boundaryConfirmed ? '<small>边界待确认</small>' : '') + '</button></div>').join('') : '<p>未识别标准标题。可在调整分段中明确指定原文范围。</p>')
                + '<button type="button" data-plan-select="original">完整原文</button><button type="button" data-plan-select="unassigned">待归属内容 ' + unresolved.length + '</button></aside>'
                + '<main><div class="plan-bound-values">' + esc(a.settings.label || '模型、时长、画幅待选择') + '</div>'
                + (part ? report.errors.concat(report.warnings).map(message => '<p class="plan-warning">' + esc(message) + '</p>').join('') + section('标题与编号', report.sections.title) + section('整体要求', report.sections.overall) + section('时间轴与结束标记', report.sections.timeline)
                    + '<label><input type="checkbox" data-plan-boundary ' + (part.boundaryConfirmed ? 'checked ' : '') + (readOnly ? 'disabled' : '') + '>确认此方案边界</label><label><input type="checkbox" data-plan-timeline ' + (part.timelineConfirmed ? 'checked ' : '') + (readOnly ? 'disabled' : '') + '>已核对时间轴和总时长</label>'
                    : a.selected === 'original' ? section('完整原文', a.source.text) : a.draft.unassigned.map(item => '<section class="plan-unassigned"><pre>' + esc(a.source.text.slice(item.start, item.end)) + '</pre><select data-plan-assign="' + esc(item.id) + '" aria-label="内容归属" ' + (readOnly ? 'disabled' : '') + '><option value="">待归属</option><option value="exclude" ' + (item.excluded ? 'selected' : '') + '>明确不创建此内容</option>' + a.draft.parts.map(target => '<option value="' + esc(target.id) + '">并入 ' + esc(target.title || '方案') + '</option>').join('') + '</select></section>').join(''))
                + '<details data-plan-adjust ' + (a.adjust ? 'open' : '') + '><summary>调整分段</summary><div class="plan-adjust">'
                + (part ? '<label>起始行<input type="number" min="1" data-plan-start value="' + lineIndex(part.ranges[0].start) + '" ' + (readOnly ? 'disabled' : '') + '></label><label>结束行<input type="number" min="1" data-plan-end value="' + lineIndex(part.ranges.at(-1).end - 1) + '" ' + (readOnly ? 'disabled' : '') + '></label><button type="button" data-plan-range ' + (readOnly ? 'disabled' : '') + '>应用范围</button><button type="button" data-plan-merge ' + (readOnly ? 'disabled' : '') + '>与下一方案合并</button><button type="button" data-plan-up class="plan-icon" aria-label="上移方案" title="上移方案">' + window.UltimateCanvasIcons('ArrowUp') + '</button><button type="button" data-plan-down class="plan-icon" aria-label="下移方案" title="下移方案">' + window.UltimateCanvasIcons('ArrowDown') + '</button>' : '')
                + '<textarea readonly data-plan-original aria-label="完整原文"></textarea><label>从原文起始行<input type="number" min="1" value="1" data-plan-new-start></label><label>到结束行<input type="number" min="1" value="' + P.lines(a.source.text).length + '" data-plan-new-end></label><button type="button" data-plan-new ' + (readOnly ? 'disabled' : '') + '>拆出此范围</button>'
                + '</div></details>'
                + (operation ? '<p>本次已创建 ' + operation.nodeIds.length + ' 个节点。</p><button type="button" data-plan-locate>定位已有节点</button><label><input type="checkbox" data-plan-copy ' + (a.copy ? 'checked' : '') + (readOnly ? 'disabled' : '') + '>明确创建新副本</label><button type="button" data-plan-undo ' + (readOnly ? 'disabled' : '') + '>撤销本次拆分</button>' : '')
                + '</main></div><p role="status" class="plan-status">' + esc(a.message || (readOnly ? '只读画布：可以查看，不可创建。' : unresolved.length ? '请明确处理待归属内容，再创建节点。' : mustConfirm ? '选中方案的边界尚未确认。' : '')) + '</p>'
                + '<footer class="canvas-plan-actions"><button type="button" data-plan-close class="context-command">取消</button><button type="button" data-plan-create class="context-primary-command" ' + (a.busy || readOnly || !chosen.length || unresolved.length || mustConfirm ? 'disabled' : '') + '>' + (a.busy ? '正在保存…' : '创建 ' + chosen.length + ' 个视频节点') + '</button></footer>';
            root.querySelector('[data-plan-original]').value = a.source.text;
            root.onclick = onClick;
            root.onchange = onChange;
            root.querySelector('[data-plan-adjust]').ontoggle = event => {
                if (active === a && event.target.isConnected && a.adjust !== event.target.open) {
                    a.adjust = event.target.open; a.draft.view = { selected: a.selected, adjust: a.adjust }; persist();
                }
            };
        }
        function changed() {
            active.changed = true;
            active.draft.unassigned = P.unassigned(active.source, active.draft.parts, active.draft.unassigned);
            persist(); render();
        }
        async function onChange(event) {
            if (!active) return;
            const target = event.target, a = active;
            if (a.busy) return;
            if (target.matches('[data-plan-version]')) {
                const id = target.value;
                persist();
                if (a.changed && !await options.flush('plan_version_change') && !a.localSafe) { a.message = '草稿尚未安全保存，请先重试保存。'; render(); return; }
                a.layer.close(); active = null; void open(a.source.nodeId, id || undefined); return;
            }
            if (!options.writable() || a.busy) return;
            const part = a.draft.parts.find(item => item.id === a.selected);
            if (target.dataset.planCheck) a.draft.parts.find(item => item.id === target.dataset.planCheck).selected = target.checked;
            else if (target.matches('[data-plan-boundary]') && part) part.boundaryConfirmed = target.checked;
            else if (target.matches('[data-plan-timeline]') && part) part.timelineConfirmed = target.checked;
            else if (target.matches('[data-plan-copy]')) { a.copy = target.checked; return; }
            else if (target.dataset.planAssign) {
                const range = a.draft.unassigned.find(item => item.id === target.dataset.planAssign);
                if (target.value === 'exclude') range.excluded = true;
                else if (target.value) {
                    const owner = a.draft.parts.find(item => item.id === target.value);
                    owner.ranges.push({ start: range.start, end: range.end });
                    owner.ranges.sort((x, y) => x.start - y.start);
                    owner.boundaryConfirmed = false; owner.timelineConfirmed = false;
                } else range.excluded = false;
            } else return;
            changed();
        }
        function rangeFromInputs(startSelector, endSelector) {
            const rows = P.lines(active.source.text), root = active.layer.dialog;
            const from = Number(root.querySelector(startSelector)?.value), to = Number(root.querySelector(endSelector)?.value);
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > rows.length) throw Error('原文行范围无效。');
            return { start: rows[from - 1].start, end: rows[to - 1].end };
        }
        async function onClick(event) {
            const target = event.target.closest('button'); if (!target || !active) return;
            event.preventDefault();
            const a = active, part = a.draft.parts.find(item => item.id === a.selected);
            try {
                if (target.hasAttribute('data-plan-close')) return void dismiss();
                if (target.dataset.planSelect) { a.selected = target.dataset.planSelect; a.draft.view = { selected: a.selected, adjust: a.adjust }; persist(); render(); return; }
                if (target.hasAttribute('data-plan-locate')) return focus(state().operations[a.draft.operationId]?.nodeIds || []);
                if (target.hasAttribute('data-plan-create')) return await createNodes();
                if (target.hasAttribute('data-plan-undo')) return await undo(a.draft.operationId);
                if (!options.writable() || a.busy) return;
                const index = a.draft.parts.indexOf(part);
                if (target.hasAttribute('data-plan-range') && part) {
                    const next = { ...part, ranges: [rangeFromInputs('[data-plan-start]', '[data-plan-end]')], boundaryConfirmed: false, timelineConfirmed: false };
                    if (!P.rangesValid(a.source, a.draft.parts.map(item => item === part ? next : item))) throw Error('范围与其他方案重叠，请先合并或调整相邻边界。');
                    Object.assign(part, next);
                } else if (target.hasAttribute('data-plan-new')) {
                    const range = rangeFromInputs('[data-plan-new-start]', '[data-plan-new-end]');
                    // Split an owned interval only at explicit source boundaries; never duplicate its bytes.
                    a.draft.parts = a.draft.parts.flatMap(item => {
                        const ranges = item.ranges.flatMap(old => {
                            if (old.end <= range.start || old.start >= range.end) return [old];
                            return [old.start < range.start ? { start: old.start, end: range.start } : null, old.end > range.end ? { start: range.end, end: old.end } : null].filter(Boolean);
                        });
                        return ranges.length ? [{ ...item, ranges, boundaryConfirmed: false, timelineConfirmed: false }] : [];
                    });
                    const heading = P.title(a.source.text.slice(range.start, range.end).split(/\r?\n/)[0]);
                    const next = { id: P.uuid(), title: heading?.title || '待确认方案', number: heading?.number || '', ranges: [range], selected: true, boundaryConfirmed: false, timelineConfirmed: false };
                    a.draft.parts.push(next); a.selected = next.id;
                } else if (target.hasAttribute('data-plan-merge') && part && a.draft.parts[index + 1]) {
                    const next = a.draft.parts[index + 1];
                    part.ranges.push(...next.ranges); part.ranges.sort((x, y) => x.start - y.start);
                    part.boundaryConfirmed = false; part.timelineConfirmed = false;
                    a.draft.parts.splice(index + 1, 1);
                } else if (part && (target.hasAttribute('data-plan-up') || target.hasAttribute('data-plan-down'))) {
                    const to = index + (target.hasAttribute('data-plan-up') ? -1 : 1);
                    if (to >= 0 && to < a.draft.parts.length) [a.draft.parts[index], a.draft.parts[to]] = [a.draft.parts[to], a.draft.parts[index]];
                } else return;
                changed();
            } catch (error) { if (active) { active.message = error.message; render(); } }
        }
        async function createNodes() {
            const a = active;
            if (!a || a.busy || !options.writable()) return;
            if (a.draft.unassigned.some(item => !item.excluded) || a.draft.parts.some(item => item.selected && !item.boundaryConfirmed)) throw Error('先确认边界和待归属内容。');
            const operation = state().operations[a.draft.operationId];
            if (operation && !a.copy) {
                focus(operation.nodeIds);
                if (!await options.flush('retry_plan_split')) throw Error('本批节点尚未保存，草稿保留，请重试保存。');
                a.layer.close(); active = null; return;
            }
            if (!engine.nodes.has(a.source.nodeId)) throw Error('来源节点已删除；原文快照可查看，不在此创建新批次。');
            if (sourceText(a.source.nodeId) !== a.source.text) throw Error('原文已修改，请先核对当前原文与旧草稿。');
            const selected = a.draft.parts.filter(item => item.selected);
            if (!selected.length) return;
            if (!P.rangesValid(a.source, a.draft.parts)) throw Error('正文范围无效；原文与预览保留。');
            const opId = a.copy ? P.uuid() : a.draft.operationId;
            const nextDraft = { ...a.draft, operationId: opId };
            const origin = engine.nodes.get(a.source.nodeId);
            const existingBounds = [...engine.nodes.values()].map(node => {
                const el = document.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]');
                const selected = el?.classList.contains('selected');
                el?.classList.add('selected');
                const nodeWidth = el?.offsetWidth || 640;
                const width = Math.max(nodeWidth, el?.querySelector('[data-generation-editor]')?.offsetWidth || nodeWidth);
                const box = { x: node.x - (width - nodeWidth) / 2, y: node.y, width, height: el?.offsetHeight || 500 };
                if (!selected) el?.classList.remove('selected');
                return box;
            });
            const occupied = [...existingBounds];
            const rows = selected.map((item, index) => {
                const data = { title: item.title, prompt: P.body(a.source, item), mode: a.settings.references.length ? 'all-reference-video' : 'text-to-video',
                    contextRules: P.clone(a.settings.contextRules || {}),
                    videoSettings: P.clone(a.settings.settings), planReferences: P.clone(a.settings.references),
                    videoCardId: a.settings.cardId, videoBranchId: a.settings.branchId, planParameterSource: a.settings.label,
                    planSource: { sourceId: a.source.id, sourceNodeId: a.source.nodeId, sourceRevision: a.source.revision,
                        version: P.VERSION, ranges: P.clone(item.ranges), planId: item.id, operationId: opId,
                        boundaryConfirmed: item.boundaryConfirmed, timelineConfirmed: item.timelineConfirmed },
                    generationStatus: 'idle' };
                let x = origin.x + (occupied.find(item => item.x === origin.x && item.y === origin.y)?.width || 350) + 64;
                let y = origin.y;
                const width = 640, height = 520;
                while (occupied.some(box => x < box.x + box.width + 32 && x + width + 32 > box.x && y < box.y + box.height + 32 && y + height + 32 > box.y)) y += height + 32;
                if (index && y > origin.y + 2 * (height + 32)) {
                    x += Math.floor(index / 3) * (width + 48); y = origin.y + index % 3 * (height + 32);
                    while (occupied.some(box => x < box.x + box.width + 32 && x + width + 32 > box.x && y < box.y + box.height + 32 && y + height + 32 > box.y)) y += height + 32;
                }
                occupied.push({ x, y, width, height });
                return { id: 'node-' + crypto.randomUUID(), type: 'video', x, y, data };
            });
            const record = { id: opId, sourceId: a.source.id, nodeIds: rows.map(row => row.id), baselines: Object.fromEntries(rows.map(row => [row.id, P.contentSignature(row)])) };
            const candidate = P.clone(options.snapshot());
            candidate.canvas.nodes.push(...rows);
            candidate.canvas.planSplits ||= P.empty();
            candidate.canvas.planSplits.sources[a.source.id] = a.source;
            candidate.canvas.planSplits.drafts[a.source.id] = nextDraft;
            candidate.canvas.planSplits.operations[opId] = record;
            if (candidate.canvas.nodes.length > 1000 || P.byteSize(candidate) + rows.length * 256 > P.MAX_BYTES) throw Error('整张画布超过2MiB或节点上限。减少选中数量；原文不会截断。');
            a.busy = true; render();
            try {
                a.draft = nextDraft; a.copy = false;
                persist();
                state().operations[opId] = record;
                rows.forEach(row => engine.addNode('video', row.x, row.y, { ...row.data, id: row.id }));
                options.snapshot();
                record.baselines = Object.fromEntries(rows.map(row => [row.id, P.contentSignature(engine.nodes.get(row.id))]));
                options.save('plan_split_create');
                options.cache();
                options.render();
                // Place using rendered node bounds, including portrait previews and inline warnings.
                const placed = [...existingBounds];
                rows.forEach(row => {
                    const node = engine.nodes.get(row.id);
                    const el = document.querySelector('[data-node-id="' + CSS.escape(row.id) + '"]');
                    const selected = el?.classList.contains('selected');
                    el?.classList.add('selected');
                    const nodeWidth = el?.offsetWidth || 640;
                    const width = Math.max(nodeWidth, el?.querySelector('[data-generation-editor]')?.offsetWidth || nodeWidth);
                    const height = el?.offsetHeight || 520, left = row.x - (width - nodeWidth) / 2;
                    if (!selected) el?.classList.remove('selected');
                    let y = row.y;
                    while (placed.some(box => left < box.x + box.width + 32 && left + width + 32 > box.x && y < box.y + box.height + 32 && y + height + 32 > box.y)) {
                        y = Math.max(...placed.filter(box => left < box.x + box.width + 32 && left + width + 32 > box.x && y < box.y + box.height + 32 && y + height + 32 > box.y).map(box => box.y + box.height + 32));
                    }
                    node.y = y; if (el) el.style.top = y + 'px';
                    placed.push({ x: left, y, width, height });
                });
                record.baselines = Object.fromEntries(rows.map(row => [row.id, P.contentSignature(engine.nodes.get(row.id))]));
                const saved = await options.flush('plan_split_create');
                if (!saved) { a.draft.operationId = opId; a.copy = false; throw Error('节点已在本地，尚未保存到服务器。请重试保存，不会重复创建。'); }
                a.draft.operationId = opId;
                focus(record.nodeIds);
                a.layer.close(); active = null;
                options.notice('已创建并保存 ' + rows.length + ' 个视频节点；尚未生成。', 'info');
            } finally { if (active === a) { a.busy = false; render(); } }
        }
        async function undo(operationId) {
            const operation = state().operations[operationId]; if (!operation || !options.writable()) return;
            const removable = [], kept = [];
            operation.nodeIds.forEach(id => {
                const node = engine.nodes.get(id); if (!node) return;
                const valuable = node.data?.taskId || node.data?.videoSubmission || node.data?.videoHistory?.length || node.data?.selectedVideoResult
                    || P.contentSignature(node) !== operation.baselines[id] || engine.connections.some(edge => edge.from === id || edge.to === id);
                (valuable ? kept : removable).push(id);
            });
            if (!await options.confirm({ title: '撤销拆分', message: '移除 ' + removable.length + ' 个未改动节点，保留 ' + kept.length + ' 个已编辑、关联或生成节点。任务、资产和费用不变。', confirmLabel: '撤销拆分' })) return;
            removable.forEach(id => engine.deleteNode(id));
            operation.nodeIds = kept; operation.undone = true;
            options.save('undo_plan_split'); options.cache();
            if (!await options.flush('undo_plan_split')) options.notice('撤销仅保存在本地，服务器尚未同步；草稿保留。', 'warn');
            options.render(); render();
        }
        function renderNode(nodeId) {
            const node = engine.nodes.get(nodeId), meta = node?.data?.planSource;
            const el = document.querySelector('[data-node-id="' + CSS.escape(nodeId) + '"]');
            if (!node || !el) return;
            if (['text', 'script'].includes(node.type)) {
                const toolbar = el.querySelector('.text-creation-toolbar');
                if (toolbar && !toolbar.querySelector('[data-plan-open]')) {
                    const button = document.createElement('button'); button.type = 'button'; button.dataset.planOpen = nodeId;
                    button.title = '拆分视频方案'; button.setAttribute('aria-label', '拆分视频方案');
                    button.innerHTML = window.UltimateCanvasIcons('Scissors'); toolbar.append(button);
                }
            }
            if (!meta) return;
            let line = el.querySelector('[data-plan-source-line]');
            if (!line) { line = document.createElement('div'); line.className = 'plan-source-line'; line.dataset.planSourceLine = ''; el.querySelector('[data-generation-editor]')?.prepend(line); }
            const source = state().sources[meta.sourceId];
            const sourceNode = engine.nodes.get(meta.sourceNodeId);
            const current = sourceNode ? sourceText(sourceNode.id) : null;
            const report = P.inspect(node.data.prompt || '', node.data.videoSettings, { boundary: meta.boundaryConfirmed, timeline: meta.timelineConfirmed });
            line.innerHTML = '<button type="button" data-plan-view-source="' + esc(nodeId) + '">查看原文</button><span>'
                + esc(!source ? '原文快照缺失' : !sourceNode ? '来源节点已删除' : current !== source.text ? '原文已修改，节点内容保持不变' : '独立方案')
                + '</span><details><summary>参数来源</summary><p>' + esc(node.data.planParameterSource || '节点自行设置') + '</p></details>'
                + '<p>当前：' + esc(node.data.videoSettings?.model || '模型待选择') + ' · ' + esc(node.data.videoSettings?.duration ? node.data.videoSettings.duration + '秒' : '时长待选择') + ' · ' + esc(node.data.videoSettings?.ratio || '画幅待选择') + '</p>'
                + (report.errors.length ? '<p class="plan-warning">' + esc(report.errors[0]) + '</p>' : '')
                + (report.warnings.length ? '<label><input type="checkbox" data-plan-node-timeline="' + esc(nodeId) + '" ' + (meta.timelineConfirmed ? 'checked ' : '') + (!options.writable() ? 'disabled' : '') + '>已核对时间轴和总时长</label>' : '');
        }
        document.addEventListener('click', event => {
            const openButton = event.target.closest('[data-plan-open]'), view = event.target.closest('[data-plan-view-source]');
            if (openButton) { event.preventDefault(); void open(openButton.dataset.planOpen); }
            if (view) {
                event.preventDefault();
                const meta = engine.nodes.get(view.dataset.planViewSource)?.data?.planSource;
                if (meta && state().sources[meta.sourceId]) void open(view.dataset.planViewSource, meta.sourceId);
                else options.notice('原文快照缺失；当前节点正文仍保留。', 'warn');
            }
        });
        document.addEventListener('change', event => {
            const target = event.target.closest('[data-plan-node-timeline]'); if (!target || !options.writable()) return;
            const node = engine.nodes.get(target.dataset.planNodeTimeline);
            if (node?.data?.planSource) { node.data.planSource.timelineConfirmed = target.checked; options.save('plan_timeline_confirmation'); options.render(); }
        });
        return { open, renderNode, focus, undo };
    }
})();
