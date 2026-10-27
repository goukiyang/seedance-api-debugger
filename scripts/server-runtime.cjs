'use strict';

// Next replaces this build-time marker itself. Standalone Node entrypoints need
// the same empty marker without enabling React's unsupported server condition.
const Module = require('node:module');
const marker = require.resolve('next/dist/compiled/server-only/empty.js');
const installed = Symbol.for('sd2.standalone-server-marker');
if (!Module[installed]) {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'server-only') return marker;
    return resolve.call(this, request, ...args);
  };
  Module[installed] = true;
}
