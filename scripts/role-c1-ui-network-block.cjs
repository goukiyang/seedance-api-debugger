'use strict';

// Inherited by the actual Next process and its children, not imported by production.
function assertLoopback(input) {
  const host = typeof input === 'string' || input instanceof URL
    ? new URL(input).hostname : String(input.hostname || input.host || 'localhost').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    throw new Error('ROLE_UI_EXTERNAL_NETWORK_BLOCKED');
  }
}
const originalFetch = globalThis.fetch;
if (originalFetch) globalThis.fetch = function(input, init) {
  assertLoopback(typeof input === 'object' && input && 'url' in input ? input.url : input);
  return originalFetch.call(this, input, init);
};
for (const name of ['http', 'https']) {
  const module = require('node:' + name);
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function(input, ...args) { assertLoopback(input); return original.call(this, input, ...args); };
  }
}
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0] : args;
  const first = options[0];
  if (typeof first === 'object' && first && !first.path) assertLoopback(first);
  else if ((typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) && typeof options[1] === 'string') {
    assertLoopback({ hostname: options[1] });
  }
  return originalConnect.apply(this, args);
};
