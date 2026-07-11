(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasGenerationTaskCoordinator = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

    function createGenerationTaskCoordinator(options) {
        const active = new Map();
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
            const existing = active.get(taskId);
            if (existing) {
                existing.nodeId = nodeId;
                return;
            }
            active.set(taskId, { taskId, nodeId, attempt: 0, errorCount: 0 });
            if (timer === null && !runningCycle) scheduleNext();
        }

        function unregister(taskId) {
            if (!active.delete(taskId)) return;
            if (!active.size) cancelTimer();
        }

        function clear() {
            active.clear();
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
                if (!active.has(entry.taskId)) return;
                if (result.status === 'rejected') {
                    entry.errorCount += 1;
                    options.onError(entry.taskId, entry.nodeId, entry.errorCount, result.reason, entry);
                    return;
                }
                entry.errorCount = 0;
                options.onStatus(entry.nodeId, result.value, entry);
                const status = result.value?.local_status || result.value?.status;
                if (TERMINAL_STATUSES.has(status)) unregister(entry.taskId);
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
