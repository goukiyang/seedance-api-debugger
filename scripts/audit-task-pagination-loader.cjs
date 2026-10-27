const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const deps = createRequire(path.join(process.env.AUD_NODE_MODULES || path.join(root, 'node_modules'), 'package.json'));
const ts = deps('typescript');
const sharedCursor = process.env.AUD_PAGINATION_CURSOR_SOURCE || (fs.existsSync(path.join(root, 'src/lib/pagination/cursor.ts'))
  ? path.join(root, 'src/lib/pagination/cursor.ts') : '/Volumes/Data/Projects/.worktrees/video-api-debugger-audit-media-policy-20261027/src/lib/pagination/cursor.ts');
exports.loader = function (mocks = {}) {
  const cache = new Map();
  function load(file) {
    const cursor = file === '@/lib/pagination/cursor' || path.resolve(root, file) === path.join(root, 'src/lib/pagination/cursor.ts');
    const target = cursor ? sharedCursor : file.startsWith('@/') ? path.join(root, 'src', file.slice(2) + '.ts') : path.resolve(root, file);
    if (cache.has(target)) return cache.get(target).exports;
    const module = { exports: {} }; cache.set(target, module);
    let source = fs.readFileSync(target, 'utf8');
    // Fixture-only exposure of the actual shared helper's private functions.
    // No token engine is copied or substituted, and Ohm's file is never edited.
    if (cursor && /function readCursor\(/.test(source) && !/\breadPageCursor\b/.test(source)) source += '\nexport { readCursor as readPageCursor, writeCursor as writePageCursor };';
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const requireModule = name => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('node:')) return require(name);
      if (name === '@/lib/pagination/cursor') return load(name);
      if (name.startsWith('@/')) return load(name);
      if (name.startsWith('.')) return load(path.resolve(path.dirname(target), name + (path.extname(name) ? '' : '.ts')));
      throw new Error('unmocked_external:' + name);
    };
    new Function('require', 'module', 'exports', '__filename', '__dirname', js)(requireModule, module, module.exports, target, path.dirname(target));
    return module.exports;
  }
  return load;
};
exports.sharedCursor = sharedCursor;
exports.ts = ts;
exports.root = root;
