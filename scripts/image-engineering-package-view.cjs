'use strict';
// Loaded only by the offline prebuild child runner. No file or production configuration is changed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const file = path.join(fs.realpathSync(process.cwd()), 'package.json');
const actual = JSON.parse(fs.readFileSync(file, 'utf8')).version;
assert.match(actual, /^\d+\.\d+\.\d+\+trace03-guard\.\d+$/);
assert.match(process.env.IMAGE_RECOVERY_GATE_RUN_ID || '', /^[a-f0-9-]{36}$/);
const view = actual.replace(/\+trace03-guard\.\d+$/, '');
const resolved = require.resolve(file);
require(resolved).version = view;
globalThis[Symbol.for('image-engineering-package-view')] = Object.freeze({
  actualVersion: actual, fixtureVersion: view, kind: 'in-memory-ordinary', productionFilesChanged: false,
});
