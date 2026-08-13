(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasGenerationTaskCoordinator = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function shouldKeepPollingTerminalStatus(result) {
        const status = result?.local_status || result?.status;
        if (status !== 'succeeded') return false;
        const deliveryStageKey = result?.delivery_stage?.key || result?.deliveryStage?.key || '';
        if (deliveryStageKey === 'failed' || deliveryStageKey === 'ready') return false;
        return deliveryStageKey === 'preparing'
            || (numberOrNull(result?.retry_after_ms ?? result?.retryAfterMs) !== null
                && (result?.stable_download_ready === false || result?.stableDownloadReady === false));
    }

    function createGenerationTaskCoordinator(options) {
        const active = new Map();
        const ownedByNode = new Map();
        let timer = null;
        let runningCycle = null;

        function cancelTimer() {
            if (timer === null) return;
            options.clearTimer(timer);
            timer = null;
        }

        function entryDelay(entry) {
            return options.delayFor(entry, options.isHidden());
        }

        function scheduleNext() {
            cancelTimer();
            if (!active.size) return;
            const delay = Math.min(...Array.from(active.values(), entryDelay));
            timer = options.setTimer(() => {
                timer = null;
                void runNow();
            }, delay);
        }

        function register(taskId, nodeId) {
            if (!taskId || !nodeId) return;
            const ownedTaskId = ownedByNode.get(nodeId);
            if (ownedTaskId && ownedTaskId !== taskId) {
                const ownedEntry = active.get(ownedTaskId);
                active.delete(ownedTaskId);
                if (ownedEntry && ownedByNode.get(ownedEntry.nodeId) === ownedTaskId) {
                    ownedByNode.delete(ownedEntry.nodeId);
                }
            }
            const existing = active.get(taskId);
            if (existing) {
                if (existing.nodeId !== nodeId) {
                    if (ownedByNode.get(existing.nodeId) === taskId) ownedByNode.delete(existing.nodeId);
                    const replacement = { taskId, nodeId, attempt: 0, errorCount: 0 };
                    active.set(taskId, replacement);
                    ownedByNode.set(nodeId, taskId);
                }
                return;
            }
            active.set(taskId, { taskId, nodeId, attempt: 0, errorCount: 0 });
            ownedByNode.set(nodeId, taskId);
            if (timer === null && !runningCycle) scheduleNext();
        }

        function unregister(taskId, nodeId) {
            const existing = active.get(taskId);
            if (nodeId && existing?.nodeId !== nodeId) return;
            if (!active.delete(taskId)) return;
            if (ownedByNode.get(existing.nodeId) === taskId) ownedByNode.delete(existing.nodeId);
            if (!active.size) cancelTimer();
        }

        function clear() {
            active.clear();
            ownedByNode.clear();
            cancelTimer();
        }

        async function performCycle() {
            cancelTimer();
            const entries = Array.from(active.values());
            const fetchEntries = [];

            entries.forEach((entry) => {
                if (!active.has(entry.taskId)) return;
                if (!options.isNodeAlive(entry.nodeId)) {
                    unregister(entry.taskId);
                    return;
                }
                entry.attempt += 1;
                fetchEntries.push(entry);
            });

            const results = await Promise.allSettled(
                fetchEntries.map(entry => options.fetchStatus(entry.taskId, entry))
            );

            results.forEach((result, index) => {
                const entry = fetchEntries[index];
                if (active.get(entry.taskId) !== entry) return;
                if (result.status === 'rejected') {
                    entry.errorCount += 1;
                    options.onError(entry.taskId, entry.nodeId, entry.errorCount, result.reason, entry);
                    return;
                }
                entry.errorCount = 0;
                entry.serverDelayMs = numberOrNull(result.value?.retry_after_ms ?? result.value?.retryAfterMs);
                options.onStatus(entry.nodeId, result.value, entry);
                const status = result.value?.local_status || result.value?.status;
                if (TERMINAL_STATUSES.has(status) && !shouldKeepPollingTerminalStatus(result.value) && active.get(entry.taskId) === entry) {
                    unregister(entry.taskId);
                }
            });

            scheduleNext();
        }

        function runNow() {
            if (runningCycle) return runningCycle;
            runningCycle = performCycle().finally(() => {
                runningCycle = null;
            });
            return runningCycle;
        }

        return {
            register,
            unregister,
            clear,
            has: taskId => active.has(taskId),
            size: () => active.size,
            runNow
        };
    }

    return { createGenerationTaskCoordinator };
});
