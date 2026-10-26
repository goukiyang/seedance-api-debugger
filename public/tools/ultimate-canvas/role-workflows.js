(function () {
    'use strict';
    window.UltimateCanvasRoleWorkflows = { create };
    function create(bridge) {
        const host = document.getElementById('role-workflows-body');
        let selectedId = '', kind = 'image', busy = false, stamp = '', pending = null, error = '';
        function contextKey() {
            const c = bridge.context();
            return c.userId && c.documentId ? [c.userId, c.projectId || '', c.documentId].map(encodeURIComponent).join(':') : '';
        }
        function key() { const value = contextKey(); return value ? 'sd2:role-workflows:v1:' + value : ''; }
        function persist() {
            try { if (key()) localStorage.setItem(key(), JSON.stringify({ selectedId, kind, pending })); }
            catch { error = '本次现场无法在浏览器记住；已保存的工作流仍在画布中。'; }
        }
        function sync() {
            const next = contextKey();
            if (stamp !== next) {
                stamp = next; selectedId = ''; kind = 'image'; pending = null; error = '';
                try {
                    const saved = JSON.parse(localStorage.getItem(key()) || '{}');
                    if (typeof saved.selectedId === 'string' && saved.selectedId.length < 160) selectedId = saved.selectedId;
                    kind = saved.kind === 'roles' ? 'roles' : 'image';
                    if (saved.pending?.document_id === bridge.context().documentId && typeof saved.pending.mutation_id === 'string'
                        && ['director-group.v1', 'blank.v1'].includes(saved.pending.template)) pending = saved.pending;
                } catch { /* Invalid optional view state is ignored. */ }
            }
            const flows = bridge.flows();
            if (selectedId && selectedId !== '__legacy__' && !flows.some(f => f.id === selectedId)) selectedId = '';
            return flows;
        }
        function current() { return sync().find(f => f.id === selectedId) || null; }
        function el(tag, text, className) {
            const value = document.createElement(tag); if (text) value.textContent = text;
            if (className) value.className = className; return value;
        }
        function command(text, action, primary) {
            const button = el('button', text, 'context-command' + (primary ? ' primary' : ''));
            button.type = 'button'; button.dataset.workflowAction = action; button.disabled = busy; return button;
        }
        function selectKind(next, save) {
            sync(); kind = next === 'roles' ? 'roles' : 'image'; if (save !== false) persist();
            bridge.showPanel(kind === 'roles' ? 'roles-panel' : 'toolflow-panel');
            render();
        }
        function render() {
            const flows = sync(); if (!host) return;
            document.querySelectorAll('[data-workflow-kind]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.workflowKind === kind)));
            host.replaceChildren();
            const templates = el('div', '', 'workflow-template-actions');
            templates.append(command('使用导演组协作', 'director-group.v1', true), command('空白协作', 'blank.v1'));
            templates.querySelectorAll('button').forEach(b => { b.disabled = busy || Boolean(pending) || !bridge.context().writable; });
            host.append(templates);
            host.append(command('我的工作流模板', 'my-templates'));
            if (pending) host.append(el('p', '模板保存结果待确认，原请求已保留。', 'role-module-status'), command('核对并继续原请求', 'recover', true));
            if (error) host.append(el('p', error, 'role-error-state'));
            const label = el('label', '当前角色工作流', 'workflow-select-label'), select = el('select');
            select.setAttribute('aria-label', '当前角色工作流'); select.dataset.workflowSelect = '';
            const empty = el('option', '选择工作流'); empty.value = ''; select.append(empty);
            flows.forEach(flow => { const option = el('option', flow.name); option.value = flow.id; select.append(option); });
            const legacy = el('option', '已有角色与历史'); legacy.value = '__legacy__'; select.append(legacy);
            select.value = selectedId; select.disabled = busy; label.append(select); host.append(label);
            const flow = flows.find(f => f.id === selectedId);
            if (flow) {
                const actions = el('div', '', 'workflow-template-actions');
                actions.append(command('提需求', 'request', true), command('本次工作', 'task'), command('加入岗位', 'add-role'), command('重命名', 'rename'));
                host.append(actions);
                const nodes = bridge.nodes().filter(n => flow.nodeIds.includes(n.id));
                if (!nodes.length) host.append(el('p', '尚未加入岗位', 'role-module-status'));
                for (const node of nodes) {
                    const role = node.roleConfig?.snapshot || {}, p = flow.participants.find(v => v.nodeId === node.id);
                    const row = el('div', '', 'workflow-role-row');
                    const open = command(role.name || node.title || '角色', 'open'); open.dataset.nodeId = node.id;
                    const edit = command('设置', 'settings'); edit.dataset.nodeId = node.id;
                    row.append(open, edit);
                    const reviewer = nodes.find(n => n.id === p?.reviewerNodeId)?.roleConfig?.snapshot?.name;
                    row.append(el('small', role.contextGaps?.length ? '待补齐：' + role.contextGaps.join('、') : role.executor?.kind === 'unassigned' ? '待指定执行者' : '岗位已配置'));
                    if (reviewer) row.append(el('small', '检查：' + reviewer));
                    host.append(row);
                }
                const missing = flow.nodeIds.filter(id => !nodes.some(n => n.id === id)).length;
                if (missing) host.append(el('p', missing + ' 个岗位已移除，原任务历史保留。', 'role-module-status'));
                const relations = el('details', '', 'workflow-relations'); relations.append(el('summary', '示例分工与材料流向'));
                const title = id => nodes.find(n => n.id === id)?.roleConfig?.snapshot?.name || '已移除岗位';
                relations.append(el('p', '协调归口：' + title(flow.coordinatorNodeId)));
                for (const p of flow.participants) {
                    if (p.dependencies.length) relations.append(el('p', p.dependencies.map(d => title(d.nodeId)).join(' + ') + ' → ' + title(p.nodeId)));
                }
                host.append(relations);
            } else if (selectedId === '__legacy__') {
                const nodes = bridge.nodes().filter(n => !flows.some(f => f.nodeIds.includes(n.id)));
                nodes.forEach(node => { const open = command(node.roleConfig?.snapshot?.name || '角色', 'open'); open.dataset.nodeId = node.id; host.append(open); });
                if (!nodes.length) host.append(el('p', '没有未归属工作流的角色。', 'role-module-status'));
            }
            const reset = command('重置工作流视图', 'reset'); host.append(reset);
        }
        async function createFlow(template) {
            if (busy || pending) return;
            const c = bridge.context(); if (!c.userId || !c.documentId || !c.writable) throw new Error('请先打开本人可编辑画布。');
            busy = true; render();
            try {
                const name = await bridge.requestName(template === 'director-group.v1' ? '导演组协作' : '角色协作');
                if (!name?.trim() || contextKey() !== stamp || c.contextEpoch !== bridge.context().contextEpoch) return;
                const saved = await bridge.saveDocument('before_workflow_template');
                pending = { mutation_id: crypto.randomUUID(), template, name: name.trim().slice(0, 80),
                    document_id: saved.documentId, document_revision: saved.documentRevision, position: bridge.position() };
                persist();
            } finally { busy = false; render(); }
            await resolve();
        }
        async function resolve() {
            if (!pending || busy) return;
            const payload = pending, c = bridge.context(), scope = contextKey(); busy = true; error = ''; render();
            try {
                let result;
                try { result = await bridge.request('/api/tools/ultimate-canvas/role-receipts/' + encodeURIComponent(payload.mutation_id)); }
                catch (e) { if (e.status !== 404) throw e; }
                if (!result) result = await bridge.request('/api/tools/ultimate-canvas/role-workflows', { method: 'POST', payload });
                if (scope !== contextKey() || c.contextEpoch !== bridge.context().contextEpoch) return;
                if (result.documentId !== payload.document_id || !result.workflowId) throw new Error('模板回执与目标不符，请保留原请求。');
                await bridge.adopt(result, payload);
                pending = null; selectedId = result.workflowId; persist();
                bridge.notice('工作流已保存，尚未创建任务或调用 AI。', 'success');
            } catch (e) {
                if (scope !== contextKey()) return;
                if (e.status >= 400 && e.status < 500 && !['write_conflict', 'mutation_conflict'].includes(e.data?.code)) pending = null;
                error = e.message || '模板结果待确认，原请求保留。'; persist();
            } finally { busy = false; render(); }
        }
        host?.addEventListener('change', event => {
            if (event.target.matches('[data-workflow-select]')) { selectedId = event.target.value; persist(); render(); }
        });
        host?.addEventListener('click', event => {
            const b = event.target.closest('[data-workflow-action]'); if (!b || b.disabled) return;
            void (async () => {
                const action = b.dataset.workflowAction, flow = current();
                if (['director-group.v1', 'blank.v1'].includes(action)) return createFlow(action);
                if (action === 'recover') return resolve();
                if (action === 'my-templates') return bridge.engine?.roleCollaboration?.openTemplates();
                if (action === 'reset') { selectedId = ''; kind = 'roles'; persist(); render(); return; }
                if (action === 'open') return bridge.openWork(b.dataset.nodeId);
                if (action === 'settings') return bridge.openSettings(b.dataset.nodeId);
                if (!flow) return;
                if (action === 'add-role') return bridge.openCreator({ saveMode: 'join' });
                if (action === 'task' || action === 'request') {
                    if (bridge.engine?.roleCollaboration) return bridge.engine.roleCollaboration.openWorkflow(flow.id, { newTask: action === 'request' });
                    const node = flow.nodeIds.find(id => bridge.nodes().some(n => n.id === id));
                    if (!node) throw new Error('请先加入岗位。');
                    return bridge.openWork(node, { configure: true });
                }
                if (action === 'rename') {
                    const scope = contextKey(), epoch = bridge.context().contextEpoch;
                    const name = await bridge.requestName(flow.name);
                    if (scope !== contextKey() || epoch !== bridge.context().contextEpoch || current()?.id !== flow.id) return;
                    if (name?.trim()) { flow.name = name.trim().slice(0, 80); await bridge.saveRelations(); render(); }
                }
            })().catch(e => { error = e.message; render(); });
        });
        document.querySelectorAll('[data-workflow-kind]').forEach(b => b.addEventListener('click', () => selectKind(b.dataset.workflowKind)));
        return { render, selectKind, current, rememberedKind: () => { sync(); return kind; },
            hasPending: () => { sync(); return Boolean(pending) || busy; }, contextChanged: () => { stamp = ''; render(); } };
    }
})();
