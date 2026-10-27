const fs = require('node:fs');
const path = require('node:path');
const { ts } = require('./audit-decode-upload-loader.cjs');
const root = process.cwd();
const deferredRoute = 'src/app/api/video/multiview/records/[taskId]/cover/route.ts';
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
const failures = [];
let deferredCalls = 0;
for (const file of files('src')) {
  const source = fs.readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const constructors = new Set(['sharp']);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const name = statement.moduleSpecifier.text;
    if (name === 'sharp' && file !== 'src/lib/media/sharp.ts') failures.push(`${file}: native decoder import bypass`);
    if ((name === 'sharp' || /(?:^|\/)sharp$/.test(name)) && statement.importClause?.name) constructors.add(statement.importClause.name.text);
  }
  for (const error of tree.parseDiagnostics) failures.push(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
  if (/limitInputPixels\s*:\s*false/.test(source)) failures.push(`${file}: unbounded image decoding`);
  function visit(node) {
    if (ts.isCallExpression(node) && constructors.has(node.expression.getText(tree)) && file !== 'src/lib/media/decode-image.ts' && file !== deferredRoute) failures.push(`${file}: direct decoder bypass`);
    if (ts.isCallExpression(node) && constructors.has(node.expression.getText(tree)) && file === deferredRoute) {
      deferredCalls++;
      if(node.arguments[0]?.getText(tree)!=='frame')failures.push(`${file}: unexpected decoder input, not the bounded handoff`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'composite' && file !== 'src/lib/media/decode-image.ts') failures.push(`${file}: unchecked composite decoder inputs`);
    if (ts.isCallExpression(node) && ['createTrustedImageCanvas','openTrustedRawImage'].includes(node.expression.getText(tree)) && !['src/lib/media/decode-image.ts','src/lib/image-studio/module-cover.ts','src/lib/video/multiview.ts'].includes(file)) failures.push(`${file}: unreviewed synthetic/raw decoder exception`);
    if (ts.isAwaitExpression(node)) {
      let fn = node.parent; while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (fn && !fn.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword)) failures.push(`${file}: await in non-async function`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
for (const file of ['src/app/api/assets/upload/route.ts', 'src/lib/assets/streamed-upload.ts']) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.arrayBuffer\(|\.formData\(|Buffer\.concat\(/.test(text)) failures.push(`${file}: whole-file aggregation`);
}
const upload = fs.readFileSync('src/app/api/assets/upload/route.ts', 'utf8');
for (const call of ['streamToTemporaryUpload(', 'readMultipartUpload(', 'uploadSiteAssetFile(']) if (!upload.includes(call)) failures.push(`ordinary upload missing ${call}`);
const direct = fs.readFileSync('src/lib/assets/direct-upload.ts', 'utf8');
if (!direct.includes('createUploadHash(expectedBytes)')) failures.push('direct upload does not share hashing');
const deps = process.env.AUD_NODE_MODULES || path.join(root, 'node_modules');
const program = ts.createProgram(['src/lib/media/decode-image.ts','src/lib/media/image-limits.ts','src/lib/media/hd-encoder.ts','src/lib/assets/streamed-upload.ts'], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true, types: ['node'],
  typeRoots: [path.join(root,'node_modules/@types'),path.join(deps,'@types')], baseUrl: root,
  paths: { '@/*': ['src/*'], sharp: [path.join(process.env.AUD_SHARP_MODULES || deps,'sharp')] },
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) failures.push(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
if(deferredCalls)console.log(`BLOCKED ${deferredRoute}: media route ownership excluded; owner must replace sharp(frame) with (await openUntrustedImage(frame, 'video-frame')) and switch the import. No global decoder acceptance.`);
if(deferredCalls>1)failures.push(`${deferredRoute}: additional direct decoders are not covered by the handoff`);
failures.forEach(value => console.error(value));
console.log(`${failures.length ? 'FAIL' : 'PASS'} owned decoder/upload syntax, focused static and helper type checks`);
console.log(`${failures.length||deferredCalls?'FAIL':'PASS'} complete decoder closure: ${deferredCalls} media-owner handoff call(s)`);
process.exitCode = failures.length || deferredCalls ? 1 : 0;
