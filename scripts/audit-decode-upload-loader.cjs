const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = process.cwd();
const deps = createRequire(path.resolve(process.env.AUD_NODE_MODULES || 'node_modules', 'package.json'));
const ts = deps('typescript');
const mocks = new Map(), cache = new Map();
function load(name, expose = '') {
  if (mocks.has(name)) return mocks.get(name);
  if (cache.has(name)) return cache.get(name).exports;
  const file = path.resolve(root, name), module = { exports: {} }; cache.set(name, module);
  const source = fs.readFileSync(file, 'utf8') + (expose ? `\nexport { ${expose} };` : '');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const req = id => {
    if (mocks.has(id)) return mocks.get(id);
    if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
    if (id.startsWith('.') && id.endsWith('.cjs')) return deps(path.resolve(path.dirname(file), id));
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(file), `${id}.ts`)));
    if (id === 'busboy') return require(path.join(root, 'node_modules/busboy'));
    return deps(id);
  };
  new Function('require','module','exports','__filename','__dirname',compiled)(req,module,module.exports,file,path.dirname(file));
  return module.exports;
}
function functions(file, names, bindings) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const source = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree)).join('\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const found = names.filter(name => tree.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  return new Function('exports', ...Object.keys(bindings), `${compiled}\nreturn { ${found.join(',')} };`)({}, ...Object.values(bindings));
}
module.exports = { load, mocks, functions, deps, ts };
