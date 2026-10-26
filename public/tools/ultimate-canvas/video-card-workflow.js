(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasVideoCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ACTIVE_BRANCH_STATUSES = new Set(['exploring', 'candidate', 'primary']);
    const GENERATABLE_CARD_STATUSES = new Set(['draft', 'active', 'reviewing']);
    const MANAGEMENT_OPERATIONS = new Set([
        'card-update',
        'card-seal',
        'card-archive',
        'card-discard',
        'branch-create',
        'branch-action',
        'version-candidate',
        'version-best',
        'version-final',
        'tasks-move',
        'card-split',
        'card-merge'
    ]);

    function encoded(value) {
        return encodeURIComponent(String(value || ''));
    }

    function activeBranches(branches) {
        if (!Array.isArray(branches)) return [];
        return branches.filter(branch => branch && ACTIVE_BRANCH_STATUSES.has(branch.status));
    }

    function chooseBranch(branches, preferredId) {
        const active = activeBranches(branches);
        if (preferredId && active.some(branch => branch.id === preferredId)) return preferredId;
        return active.find(branch => branch.is_primary || branch.status === 'primary')?.id
            || active[0]?.id
            || '';
    }

    function operationAllowed(detail, operation) {
        const card = detail?.video_card || detail?.videoCard || detail || {};
        const permissions = detail?.permissions || card.permissions || {};
        if (operation === 'view') return permissions.can_view !== false;
        if (operation === 'generate') {
            const canGenerate = permissions.can_generate ?? card.can_generate;
            return Boolean(canGenerate) && GENERATABLE_CARD_STATUSES.has(card.status);
        }
        if (operation === 'approval-ratio' || operation === 'approval-reopen') {
            return permissions.can_view !== false;
        }
        if (!MANAGEMENT_OPERATIONS.has(operation)) return true;
        if (!permissions.can_manage && !card.can_manage) return false;
        if (operation === 'card-update') {
            return !['sealed', 'merged', 'archived', 'discarded'].includes(card.status);
        }
        if (operation === 'card-seal') {
            return ['draft', 'active', 'reviewing', 'finalized'].includes(card.status);
        }
        if (operation === 'card-discard') return card.removal_action === 'discard';
        if (operation === 'card-archive') {
            return card.removal_action === 'archive'
                || ['draft', 'active', 'reviewing', 'finalized'].includes(card.status);
        }
        return !['merged', 'archived', 'discarded'].includes(card.status);
    }

    const requestBuilders = {
        'card-update': ({ cardId, values }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: values || {}
        }),
        'card-seal': ({ cardId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { seal: true }
        }),
        'card-archive': ({ cardId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { action: 'archive' }
        }),
        'card-discard': ({ cardId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { action: 'discard' }
        }),
        'branch-create': ({ cardId, title, description, confirmOverLimit }) => ({
            url: `/api/video-cards/${encoded(cardId)}/branches`,
            method: 'POST',
            payload: {
                title,
                description: description || null,
                ...(confirmOverLimit ? { confirm_over_limit: true } : {})
            }
        }),
        'branch-action': ({ cardId, branchId, action, targetBranchId, title, reason }) => ({
            url: `/api/video-cards/${encoded(cardId)}/branches/${encoded(branchId)}`,
            method: 'PATCH',
            payload: {
                action,
                ...(targetBranchId ? { target_branch_id: targetBranchId } : {}),
                ...(title ? { title } : {}),
                ...(reason ? { reason } : {})
            }
        }),
        'version-candidate': ({ cardId, taskId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { candidate_task_id: taskId }
        }),
        'version-best': ({ cardId, taskId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { current_best_task_id: taskId }
        }),
        'version-final': ({ cardId, taskId }) => ({
            url: `/api/video-cards/${encoded(cardId)}`,
            method: 'PATCH',
            payload: { final_task_id: taskId }
        }),
        'tasks-move': ({ cardId, targetCardId, taskIds, targetBranchId, reason }) => ({
            url: `/api/video-cards/${encoded(cardId)}/tasks`,
            method: 'PATCH',
            payload: {
                action: 'move',
                target_video_card_id: targetCardId,
                task_ids: Array.isArray(taskIds) ? taskIds : [],
                target_branch_id: targetBranchId || null,
                reason: reason || null
            }
        }),
        'card-split': ({ cardId, title, taskIds, reason }) => ({
            url: `/api/video-cards/${encoded(cardId)}/split`,
            method: 'POST',
            payload: {
                title,
                task_ids: Array.isArray(taskIds) ? taskIds : [],
                reason: reason || null
            }
        }),
        'card-merge': ({ cardId, targetCardId, reason }) => ({
            url: `/api/video-cards/${encoded(cardId)}/merge`,
            method: 'POST',
            payload: {
                target_video_card_id: targetCardId,
                reason: reason || null
            }
        }),
        'approval-ratio': ({ projectId, cardId, targetRatio, reason }) => ({
            url: '/api/approvals',
            method: 'POST',
            payload: {
                type: 'ratio_change',
                project_id: projectId,
                video_card_id: cardId,
                reason,
                payload: {
                    source: 'ultimate_canvas',
                    target_ratio: targetRatio,
                    change_reason: reason
                }
            }
        }),
        'approval-reopen': ({ projectId, cardId, reason }) => ({
            url: '/api/approvals',
            method: 'POST',
            payload: {
                type: 'video_card_reopen',
                project_id: projectId,
                video_card_id: cardId,
                reason,
                payload: {
                    source: 'ultimate_canvas',
                    target_status: 'active',
                    reopen_reason: reason
                }
            }
        }),
        'task-retry': ({ taskId }) => ({
            url: `/api/video/retry/${encoded(taskId)}`,
            method: 'POST',
            payload: {}
        })
    };

    function requestFor(operation, input = {}) {
        const builder = requestBuilders[operation];
        if (!builder) throw new Error(`不支持的视频卡操作：${operation}`);
        return builder(input);
    }

    function generationContext(input = {}) {
        return {
            project_id: input.projectId || null,
            video_card_id: input.cardId || null,
            video_branch_id: input.branchId || null,
            canvas_document_id: input.documentId || null,
            canvas_node_id: input.nodeId || null,
            tab_id: input.tabId || ''
        };
    }

    return {
        activeBranches,
        chooseBranch,
        generationContext,
        operationAllowed,
        requestFor
    };
});
