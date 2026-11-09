const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const editor = read('src/components/PromptEditor.tsx');
const tree = ts.createSourceFile('PromptEditor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText;
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(tree));
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    declarations.set(node.name.getText(tree), node.initializer.arguments[0]?.getText(tree));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const checks = [];
function check(name, run) {
  try { run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
check('height changes preserve the current textarea viewport', () => {
  const textarea = { scrollTop: 710, scrollLeft: 23, scrollHeight: 1800 };
  textarea.style = new Proxy({}, { set(target, key, value) {
    target[key] = value;
    if (key === 'height') { textarea.scrollTop = 0; textarea.scrollLeft = 0; }
    return true;
  } });
  const fit = vm.runInNewContext(compile(`${declarations.get('fitTextareaHeight')}; fitTextareaHeight`), {
    window: { getComputedStyle: () => ({ maxHeight: '320px' }) }, getPromptTextareaMaxHeight: () => 320,
  });
  fit(textarea);
  assert.equal(textarea.style.height, '320px');
  assert.equal(textarea.style.overflowY, 'auto');
  assert.equal(textarea.scrollTop, 710);
  assert.equal(textarea.scrollLeft, 23);
});
check('insertion restores the caret without moving the page or textarea viewport', () => {
  const frames = [], calls = [];
  const textarea = { scrollTop: 710, scrollLeft: 23,
    focus(options) { calls.push(options); this.scrollTop = 0; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; this.scrollTop = 900; this.scrollLeft = 0; },
  };
  const focus = vm.runInNewContext(compile(`(${declarations.get('focusTextareaAt')})`), {
    window: { requestAnimationFrame: callback => frames.push(callback) },
  });
  focus({ current: textarea }, 222);
  frames.shift()();
  assert.equal(calls[0]?.preventScroll, true);
  assert.equal(textarea.selectionStart, 222);
  assert.equal(textarea.selectionEnd, 222);
  assert.equal(textarea.scrollTop, 710);
  assert.equal(textarea.scrollLeft, 23);
});
check('expanded references have thumbnails and separate preview and insertion actions', () => {
  const previews = [], inserts = [];
  const render = vm.runInNewContext(compile(`(${declarations.get('expandedReferenceButtons')})`), {
    React, hasReferences: true,
    referenceLabels: [{ label: 'image1', title: 'Reference 1', thumbnailUrl: '/authorized/thumb.png' }],
    ImagePlus: () => null, insertDraftReference: label => inserts.push(label),
    onPreviewReference: label => previews.push(label),
  });
  const elements = render();
  const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, elements));
  assert.ok(markup.includes('src="/authorized/thumb.png"'));
  const buttons = [];
  function collect(element) {
    if (!React.isValidElement(element)) return;
    if (element.type === 'button') buttons.push(element);
    React.Children.forEach(element.props.children, collect);
  }
  elements.forEach(collect);
  const preview = buttons.find(button => button.props['aria-label'] === '\u9884\u89c8image1');
  assert.ok(preview);
  preview.props.onClick();
  assert.deepEqual(previews, ['image1']);
  assert.deepEqual(inserts, []);
  buttons.find(button => button !== preview).props.onClick();
  assert.deepEqual(inserts, ['image1']);
});
check('redesigned creation recovery is inside the composer before generation controls', () => {
  const composer = read('src/components/GenerationComposer.tsx');
  const page = read('src/components/generate/GeneratePageClient.tsx');
  const recovery = composer.lastIndexOf('{creationRecovery}');
  assert.ok(recovery > composer.indexOf('<PromptEditor') && recovery < composer.indexOf('<ComposerActionBar'));
  assert.ok(page.includes('creationRecovery={normalVideoRedesign ? creationAvailability : undefined}'));
  assert.ok(page.includes('{(!normalVideoRedesign || imageResultRequested !== false && !imageResultHandoff) && creationAvailability}'));
  assert.equal((page.match(/<CreationAvailability\s/g) || []).length, 1);
  assert.ok(composer.includes('!submitDisabledReason'));
});
check('recovery remains available while an image handoff hides the composer', () => {
  const source = read('src/components/generate/GeneratePageClient.tsx');
  const ast = ts.createSourceFile('GeneratePageClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let condition;
  function find(node) {
    if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && node.expression.right.getText(ast) === 'creationAvailability') condition = node.expression.left.getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(condition);
  for (const imageResultRequested of [null, false, true]) {
    for (const handoff of [false, true]) {
      for (const normalVideoRedesign of [false, true]) {
        const composerVisible = imageResultRequested === false || handoff;
        const external = Boolean(vm.runInNewContext(condition, { normalVideoRedesign, imageResultRequested, imageResultHandoff: handoff ? {} : null, Boolean }));
        const inline = composerVisible && normalVideoRedesign;
        assert.equal(Number(external) + Number(inline), 1, JSON.stringify({ imageResultRequested, handoff, normalVideoRedesign }));
      }
    }
  }
});
check('reference thumbnails and preview use the same protected media identity', () => {
  const source = read('src/components/GenerationComposer.tsx');
  const ast = ts.createSourceFile('GenerationComposer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'referenceLabels') callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast);
  const labels = vm.runInNewContext(compile(`(${callback})`), { encodeURIComponent, imageReferenceAssets: [
    { assetId: 'asset-a', fileName: 'A', originalUrl: '/private/original-a.png' },
    { assetId: 'asset-b', referenceImageId: 'reference-b', fileName: 'B', originalUrl: '/private/original-b.png' },
  ] })();
  assert.equal(labels[0].contentKey, 'asset:asset-a');
  assert.equal(labels[1].contentKey, 'reference_image:reference-b');
  assert.ok(labels[0].thumbnailUrl.includes('key=asset%3Aasset-a&variant=thumbnail'));
  assert.ok(labels[1].previewUrl.includes('/reference-b/content?variant=preview'));
  assert.ok(labels.every(label => !label.thumbnailUrl.includes('/private/original')));
  const css = read('src/app/globals.css');
  assert.ok(css.includes('grid-template-rows: auto auto minmax(0, 1fr) auto'));
  assert.ok(css.includes('.composer-expanded-reference-preview img'));
});
check('unknown preparation keeps the existing explicit recovery actions', () => {
  const module = { exports: {} };
  const requireModule = name => {
    if (name === 'react') return React;
    if (name.endsWith('.module.css')) return {};
    if (name === '@/lib/hooks/use-creation-context') return { isResolvedCreationIntent: intent => Boolean(intent?.accepted_task_id) };
    if (name === '@/lib/navigation/return-to') return { taskDetailHref: id => `/tasks/${id}` };
    if (name === '@/components/RelativeTime') return { RelativeTime: () => null };
    throw Error(`Unexpected dependency: ${name}`);
  };
  new Function('require', 'module', 'exports', 'React', compile(read('src/components/creation/CreationAvailability.tsx')))(requireModule, module, module.exports, React);
  const controller = { contextKey: 'synthetic', context: null, intent: null, loading: false,
    error: 'Unknown original preparation', unconfirmedRequestId: 'original-request',
  };
  const markup = renderToStaticMarkup(React.createElement(module.exports.default, { controller, hideSummary: true }));
  for (const label of ['\u91cd\u65b0\u8bfb\u53d6', '\u6838\u5bf9\u539f\u8bf7\u6c42', '\u6838\u5bf9\u5e76\u7ed3\u675f\u672c\u6b21\u51c6\u5907']) assert.ok(markup.includes(label));
  assert.equal(controller.unconfirmedRequestId, 'original-request');
});
console.log(JSON.stringify({ checks, browserLayoutVerified: false, productionWrites: 0, paidRequests: 0 }, null, 2));
if (checks.some(result => !result.passed)) process.exitCode = 1;
