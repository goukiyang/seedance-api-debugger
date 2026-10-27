const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = createRequire(path.join(process.env.AUD_NODE_MODULES || path.join(root, 'node_modules'), 'package.json'))('typescript');
exports.loadFunction = (file, name, bindings) => {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  if (!node) throw new Error('function_missing');
  const js = ts.transpileModule(node.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(bindings), js + `\nexports.run = ${name};`)(exports, ...Object.values(bindings));
  return exports.run;
};
exports.loader = function (mocks = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = fs.readFileSync(file, 'utf8');
    const js = file.endsWith('.cjs') ? source : ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const requireModule = name => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('node:')) return require(name);
      let target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!target) throw new Error('unmocked_external:' + name);
      if (!path.extname(target)) target += '.ts';
      return load(target);
    };
    new Function('require', 'module', 'exports', '__filename', '__dirname', js)(requireModule, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  return load;
};
