const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = process.cwd();
const deps = createRequire(path.resolve(process.env.AUD_NODE_MODULES || 'node_modules', 'package.json'));
const ts = deps('typescript');

// These are credential-bearing dispatch, not arbitrary resource downloads. Keep their own sender contracts.
const trustedDispatch = {
  'src/lib/provider/jimeng.ts': 'configured Seedance API; privatePromptFetch/assertPrivateSend guard remains authoritative',
  'src/lib/provider/volcengine-ip.ts': 'configured Ark API with account credentials',
  'src/lib/provider/h3.ts': 'configured H3 service, including intentional localhost service; internal output uses authenticated API',
  'src/lib/provider/aimediakit-enhance-video.ts': 'configured MediaKit API and provider-issued signed upload ticket; no caller-provided upload URL',
  'src/lib/provider/seedance-assets.ts': 'constant Seedance asset API origin plus encoded operation paths',
  'src/lib/image-studio/provider.ts': 'credential dispatch retains privatePromptFetch; custom transport uses shared validated DNS and pinned lookup',
  'src/lib/image-studio/billing-provider.ts': 'configured supplier billing API, credentials and redirect:error; billing ownership excluded',
  'src/lib/costs/provider-balance.ts': 'configured supplier balance API, not an asset URL',
  'src/lib/canvas-roles/execution.ts': 'trusted private-prompt dispatch guard, not resource download',
  'src/lib/canvas-roles/text-provider.ts': 'literal Musk origin plus encoded task identity and existing credentials',
  'src/lib/security/private-prompt-send.server.ts': 'trusted sender wrapper; do not replace it with public-resource transport',
  'src/lib/auth/feishu.ts': 'existing Feishu OAuth API and permissions; auth ownership excluded',
  'src/lib/auth/registration/email.ts': 'constant Resend API origin with configured credential; auth ownership excluded',
  'src/lib/feedback/delivery.ts': 'constant open.feishu.cn API origin; real Feishu permission contract preserved',
  'src/lib/feedback/attachments.ts': 'constant open.feishu.cn image upload API',
  'src/lib/credits/request-delivery.ts': 'constant open.feishu.cn API origin; billing ownership excluded',
  'src/lib/billing/alerts.ts': 'constant open.feishu.cn message API, redirect:error, pinned administrator/app/tenant and same deduplication UUID; no user resource URL',
  'src/lib/cutout/proxy.ts': 'configured internal cutout service; bounded operation paths, service auth, manual redirects',
};
const deferred = {};
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
function inspect(file, source, client = false) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures = tree.parseDiagnostics.map(diagnostic => `${file}:${tree.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      // This fixed trusted alert recipient flow is not a resource proxy. A
      // future variable URL in the same file must still fail this check.
      const databaseAlertCall = file === 'src/lib/database/alerts.ts' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
      if (/^(fetch|fetchImpl|fetcher)$|^(globalThis|resolved|options)\.fetch(Impl)?$/.test(callee)
        && !client && !trustedDispatch[file] && !deferred[file] && !databaseAlertCall) failures.push(`${file}:${tree.getLineAndCharacterOfPosition(node.pos).line + 1}: unclassified direct fetch`);
      if (/^(http|https)\.(request|get)$/.test(callee) && file !== 'src/lib/net/safe-fetch.ts' && file !== 'src/lib/image-studio/provider.ts') {
        failures.push(`${file}: unclassified native HTTP transport`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}
module.exports = { inspect, trustedDispatch, deferred };
if (require.main === module) {
  const sourceFiles = files(path.join(root, 'src'));
  const sources = new Map(sourceFiles.map(file => [path.relative(root, file), fs.readFileSync(file, 'utf8')]));
  const client = new Set();
  function mark(file) {
    if (client.has(file) || !sources.has(file)) return;
    client.add(file);
    const tree = ts.createSourceFile(file, sources.get(file), ts.ScriptTarget.Latest, true);
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      const name = node.moduleSpecifier.text;
      const base = name.startsWith('@/') ? `src/${name.slice(2)}` : name.startsWith('.') ? path.join(path.dirname(file), name) : null;
      if (!base) continue;
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (sources.has(base + suffix)) { mark(base + suffix); break; }
    }
  }
  for (const [file, source] of sources) {
    const first = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements[0];
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client') mark(file);
  }
  const failures = [...sources].flatMap(([file, source]) => inspect(file, source, !file.startsWith('src/app/api/') && client.has(file)));
  const calls = {
    'src/server/video-tasks/standard-create.ts': ['probeRemoteMedia', 'validateExternalCallbackUrl'],
    'src/lib/provider/ip-reference-media-metadata.ts': ['probeRemoteMedia'],
    'src/lib/video/multiview.ts': ['downloadRemoteMedia', 'probeMediaFile'],
    'src/app/api/tasks/enhance-video/create/route.ts': ['probeRemoteMedia', 'probeMediaFile', 'resolveInside'],
    'src/lib/feedback/pdf.ts': ['safeFetch', 'resolveInside'],
    'src/lib/video/thumbnail.ts': ['withRemoteMediaFile', 'mediaInputFlags', 'resolveInsideSync'],
    'src/lib/video/local-cache.ts': ['safeFetch', 'resolveInsideSync'],
    'src/lib/media/preview-response.ts': ['safeFetch', 'resolveInside'],
    'src/app/api/provider/seedance/callback/route.ts': ['safeFetch'],
  };
  for (const [file, names] of Object.entries(calls)) for (const name of names) {
    if (!sources.get(file)?.includes(`${name}(`)) failures.push(`${file}: missing actual ${name} call`);
  }
  const program = ts.createProgram(['src/lib/net/public-address.ts', 'src/lib/net/safe-fetch.ts', 'src/lib/fs/resolve-inside.ts', 'src/lib/media/probe-remote.ts'], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true,
    types: ['node'], typeRoots: [path.resolve(process.env.AUD_NODE_MODULES || 'node_modules', '@types')],
    baseUrl: root, paths: { '@/*': ['src/*'] },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) failures.push(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  for (const [file, reason] of Object.entries(deferred)) console.log(`GAP ${file}: ${reason}`);
  for (const failure of failures) console.error(failure);
  console.log(`${failures.length ? 'FAIL' : 'PASS'} focused network static checks and helper typecheck; ${Object.keys(trustedDispatch).length} scoped trusted dispatch exceptions; ${Object.keys(deferred).length} deferred self-dispatch gap`);
  process.exitCode = failures.length ? 1 : 0;
}
