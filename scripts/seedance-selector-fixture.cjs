const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ts, root, loader } = require('./audit-task-pagination-loader.cjs');
const deps = createRequire(path.join(process.env.AUD_NODE_MODULES || path.join(root, 'node_modules'), 'package.json'));
const React = deps('react');
const { renderToStaticMarkup } = deps('react-dom/server');

exports.selectorFixture = function (fetcher) {
  let session = { ownerId: 'synthetic-owner', epoch: 0 }, blocked = false;
  const pagesModule = loader()('src/lib/pagination/seedance-pages.ts');
  const pager = pagesModule.createSeedancePages({ fetch: fetcher, session: () => session, blocked: () => blocked });
  pager.setScope({ ...session, includeDeleted: false, visible: true });
  let nodes = [], refs = [], refIndex = 0, stateIndex = 0;
  const react = {
    ...React,
    createElement(type, props, ...children) {
      const element = React.createElement(type, props, ...children);
      nodes.push(element);
      return element;
    },
    useState(initial) {
      // Open the existing picker in the render fixture, without adding a test API.
      return React.useState(stateIndex++ === 0 && initial === false ? true : initial);
    },
    useRef(initial) {
      const live = React.useRef(initial), index = refIndex++;
      // Retain ref identity across controlled renders for stale event contracts.
      return refs[index] || (refs[index] = live);
    },
  };
  const mocks = {
    react,
    'lucide-react': deps('lucide-react'),
    '@/components/useDialogDismiss': { useDialogDismiss() {} },
    '@/lib/http/upload-session': { uploadSession: () => session },
    '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => blocked },
    '@/lib/pagination/seedance-pages': pagesModule,
    '@/lib/pagination/use-seedance-pages': { useSeedanceAssetPages(visible, includeDeleted) {
      assert.equal(visible, true); assert.equal(includeDeleted, false);
      return { ...pager.getSnapshot(), more: pager.more, retry: pager.retry, refresh: pager.refresh };
    } },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'src/components/SeedanceAssetSelector.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name in mocks, 'unmocked selector dependency: ' + name); return mocks[name];
  }, module, module.exports);
  return {
    pager,
    setSession(next) { session = next; pager.setScope({ ...session, includeDeleted: false, visible: true }); },
    block() { blocked = true; pager.invalidate(); },
    render(props = {}) {
      nodes = []; refIndex = 0; stateIndex = 0;
      const html = renderToStaticMarkup(React.createElement(module.exports.SeedanceAssetSelector, { value: [], onChange() {}, ...props }));
      return { html, nodes: [...nodes], button(label) {
        return nodes.find(node => node.type === 'button' && (node.props['aria-label'] === label || node.props.title === label));
      } };
    },
  };
};

exports.asset = (id, overrides = {}) => ({ localId: id, provider: 'seedance', providerAssetId: 'provider-' + id,
  assetType: 'Image', name: id, originalUrl: 'https://synthetic.invalid/' + id + '.png',
  ownerId: 'synthetic-owner', ownershipStatus: 'owned',
  providerPreviewUrl: null, providerStatus: 'Active', status: 'Active', createdAt: '2026-10-27T00:00:00.000Z', ...overrides });
exports.page = (assets, hasMore, total = assets.length, cursor = 'synthetic-cursor') => Response.json({ assets,
  pagination: { limit: 24, total, hasMore, nextCursor: hasMore ? cursor : null } });
