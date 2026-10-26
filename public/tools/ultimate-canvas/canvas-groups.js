(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasGroups = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function uniqueToken() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function selectedIds(engine) {
        if (typeof engine?.getSelectedNodeIds === 'function') return engine.getSelectedNodeIds();
        return [...(engine?.selectedNodeIds || [])].filter(id => engine?.nodes?.has(id));
    }

    function groupMembers(engine, groupId) {
        return [...engine.nodes.values()].filter(node => node.data?.canvasGroup?.id === groupId);
    }

    function perform(engine, commands, label, operation) {
        if (commands?.perform) return commands.perform(label, operation);
        const result = operation();
        if (result !== false && result?.ok !== false) engine._notifyCanvasGeometryChanged?.('group', { label });
        return result;
    }

    function groupSelected(engine, commands, options = {}) {
        const ids = selectedIds(engine);
        if (ids.length < 2) return { ok: false, reason: 'select-at-least-two-nodes' };
        const groupId = String(options.id || `group-${uniqueToken()}`);
        const name = typeof options.name === 'string' ? options.name.trim().slice(0, 80) : '';
        return perform(engine, commands, '组合节点', () => {
            ids.forEach(id => {
                const node = engine.nodes.get(id);
                node.data = { ...(node.data || {}), canvasGroup: { version: 1, id: groupId, ...(name ? { name } : {}) } };
            });
            return { ok: true, groupId, nodeIds: ids };
        });
    }

    function ungroupSelected(engine, commands) {
        const ids = selectedIds(engine);
        const groupIds = new Set(ids.map(id => engine.nodes.get(id)?.data?.canvasGroup?.id).filter(Boolean));
        if (!groupIds.size) return { ok: false, reason: 'selection-has-no-group' };
        return perform(engine, commands, '取消组合', () => {
            const changedIds = [];
            engine.nodes.forEach(node => {
                if (!groupIds.has(node.data?.canvasGroup?.id)) return;
                const data = { ...(node.data || {}) };
                delete data.canvasGroup;
                node.data = data;
                changedIds.push(node.id);
            });
            return { ok: changedIds.length > 0, groupIds: [...groupIds], nodeIds: changedIds };
        });
    }

    function renameGroup(engine, commands, groupId, name) {
        const safeName = String(name || '').trim().slice(0, 80);
        const members = groupMembers(engine, groupId);
        if (!members.length) return { ok: false, reason: 'group-not-found' };
        return perform(engine, commands, '重命名组合', () => {
            members.forEach(node => {
                const group = node.data.canvasGroup;
                node.data = {
                    ...(node.data || {}),
                    canvasGroup: { ...group, version: 1, id: groupId, ...(safeName ? { name: safeName } : {}) }
                };
                if (!safeName) delete node.data.canvasGroup.name;
            });
            return { ok: true, groupId, name: safeName, nodeIds: members.map(node => node.id) };
        });
    }

    function listGroups(engine) {
        const groups = new Map();
        engine.nodes.forEach(node => {
            const group = node.data?.canvasGroup;
            if (!group?.id) return;
            if (!groups.has(group.id)) groups.set(group.id, { id: group.id, name: group.name || '', nodeIds: [] });
            groups.get(group.id).nodeIds.push(node.id);
        });
        return [...groups.values()];
    }

    return { groupSelected, ungroupSelected, renameGroup, listGroups };
});
