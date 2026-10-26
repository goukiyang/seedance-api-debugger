(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UltimateCanvasSaveCoordinator = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function createCanvasSaveCoordinator(options) {
        let revision = 0;
        let pending = null;
        let running = false;
        let lastOutcome = { ok: true, revision: 0, result: null };
        const waiters = [];

        function settleWaiters(outcome) {
            for (let index = waiters.length - 1; index >= 0; index -= 1) {
                if (waiters[index].revision > outcome.revision) continue;
                const waiter = waiters.splice(index, 1)[0];
                waiter.resolve(outcome);
            }
        }

        async function drain() {
            if (running) return;
            running = true;
            try {
                while (pending) {
                    const job = pending;
                    pending = null;
                    options.onStart?.(job);
                    try {
                        const result = await options.executor(job);
                        lastOutcome = { ok: true, revision: job.revision, result };
                        if (!options.isCurrent || options.isCurrent(job)) {
                            options.onSuccess?.(result, job, { hasPending: Boolean(pending) });
                        }
                    } catch (error) {
                        lastOutcome = { ok: false, revision: job.revision, error };
                        if (!options.isCurrent || options.isCurrent(job)) {
                            options.onError?.(error, job, { hasPending: Boolean(pending) });
                        }
                    }
                    settleWaiters(lastOutcome);
                }
            } finally {
                running = false;
                if (pending) void drain();
            }
        }

        function request(snapshot) {
            const job = { revision: ++revision, snapshot };
            pending = job;
            const result = new Promise(resolve => waiters.push({ revision: job.revision, resolve }));
            void drain();
            return result;
        }

        function flush(snapshot) {
            if (arguments.length > 0) return request(snapshot);
            if (!running && !pending) return Promise.resolve(lastOutcome);
            const targetRevision = pending?.revision || revision;
            return new Promise(resolve => waiters.push({ revision: targetRevision, resolve }));
        }

        return {
            request,
            flush,
            isRunning: () => running,
            pendingRevision: () => pending?.revision || null
        };
    }

    return { createCanvasSaveCoordinator };
});
