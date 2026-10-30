import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { multiviewActionPrivateTaskMarker, multiviewPrivateTaskMarker, projectPrivateMultiviewTask } from '../src/lib/video/multiview-task-privacy';

const file = 'src/app/tasks/[id]/page.tsx';
const source = process.env.PAGE_REV
  ? execFileSync('git', ['show', `${process.env.PAGE_REV}:${file}`], { encoding: 'utf8' })
  : readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    declarations.set(node.name.text, node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const names = ['taskPlaybackUrl', 'taskVideoSource', 'handleCopyUrl', 'handleOpenVideo', 'handleBrowserDownloadVideo'];
const conditions = ['hasPublicVideo', 'hasLocalVideo', 'hasFallbackVideo', 'hasPlayableVideo',
  'isPublicVideoPreparing', 'isSlowFallbackVideo', 'hasResultVideo', 'canUseVideoActions',
  'isSubmissionUnknown', 'isProcessing', 'resultStateTitle', 'resultStorageText'];
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
async function inspect(task: Record<string, unknown>, actions = false) {
  const opened: string[] = [], copied: string[] = [], downloads: string[] = [];
  const forbidden = () => { throw new Error('Unexpected preparation, polling, or network request'); };
  const context: Record<string, any> = {
    task, URL, Boolean, isEnhanceTask: false, activePageRef: { current: true },
    window: { location: { origin: 'https://fixture.invalid', assign: (url: string) => opened.push(url) } },
    navigator: { clipboard: { writeText: async (url: string) => copied.push(url) } },
    document: { body: { appendChild() {} }, createElement: () => ({ href: '', click() { downloads.push(this.href); }, remove() {} }) },
    fetch: forbidden, fetchTask: forbidden, downloadVideoToLocal: forbidden, setTimeout() {},
    setOpenError: (error: unknown) => { assert.equal(error, null); },
    setCopyingLink() {}, setCopied() {}, setOpeningVideo() {}, setBrowserDownloading() {},
  };
  const code = names.map(name => `const ${name} = ${declarations.get(name)};`).join('\n')
    + '\nconst videoSrc = taskVideoSource(task);\n'
    + `const hasProtectedPlayback = ${declarations.get('hasProtectedPlayback') || 'false'};\n`
    + conditions.map(name => `const ${name} = ${declarations.get(name)};`).join('\n')
    + '\nglobalThis.result = { videoSrc, hasResultVideo, canUseVideoActions, resultStateTitle, resultStorageText };'
    + '\nglobalThis.actions = [handleOpenVideo, handleCopyUrl, handleBrowserDownloadVideo];';
  vm.runInNewContext(compile(code), context);
  if (actions) for (const action of context.actions) await action();
  return { ...context.result, opened, copied, downloads };
}
async function main() {
  const markers = [multiviewPrivateTaskMarker('1.0.0'), multiviewActionPrivateTaskMarker({
    runId: 'fixture-run', workId: 'fixture-work', revision: 1, recipeHash: 'a'.repeat(64), inputHash: 'b'.repeat(64),
  })];
  let cases = 0;
  for (const marker of markers) {
    for (const media of [{ local_video_path: '/videos/private.mp4' },
      { public_video_url: 'https://private.invalid/output.mp4' },
      { result_video_url: 'https://private.invalid/provider-output.mp4' }]) {
      const projected = projectPrivateMultiviewTask({ id: 'fixture-task', local_status: 'succeeded',
        source_metadata_json: JSON.stringify({ protected_module: marker }), prompt: 'SECRET_RECIPE',
        params_json: 'SECRET_SYSTEM_IMAGE', raw_create_response: 'SECRET_CREDENTIAL', ...media });
      const serialized = JSON.stringify(projected);
      assert.ok(!/SECRET_|private\.invalid|private\.mp4/.test(serialized));
      const result = await inspect(projected, true);
      assert.equal(result.videoSrc, '/api/video/play/fixture-task');
      assert.equal(result.hasResultVideo, true, 'completed protected output must render the result player');
      assert.equal(result.canUseVideoActions, true);
      assert.notEqual(result.resultStateTitle, '\u6682\u65e0\u7ed3\u679c');
      assert.notEqual(result.resultStorageText, '\u6ca1\u6709\u89c6\u9891\u94fe\u63a5');
      assert.deepEqual(result.opened, ['https://fixture.invalid/api/video/play/fixture-task']);
      assert.deepEqual(result.copied, result.opened);
      assert.deepEqual(result.downloads, [(projected as any).download_url || '/api/video/play/fixture-task']);
      cases++;
    }
    for (const status of ['running', 'unknown', 'failed', 'succeeded']) {
      const projected = projectPrivateMultiviewTask({ id: 'empty', local_status: status,
        source_metadata_json: JSON.stringify({ protected_module: marker }) });
      const result = await inspect(projected);
      assert.equal(result.videoSrc, '');
      assert.equal(result.hasResultVideo, false);
      assert.equal(result.canUseVideoActions, false);
      cases++;
    }
  }
  for (const [media, expected] of [
    [{ public_video_url: 'https://public.invalid/video.mp4' }, 'https://public.invalid/video.mp4'],
    [{ local_video_path: '/videos/legacy.mp4' }, '/api/video/play/legacy'],
    [{ result_video_url: 'https://provider.invalid/legacy.mp4' }, 'https://provider.invalid/legacy.mp4'],
  ] as const) {
    const result = await inspect({ id: 'legacy', local_status: 'succeeded', public_video_storage_provider: 'configured', ...media });
    assert.equal(result.videoSrc, expected);
    assert.equal(result.hasResultVideo, true);
    cases++;
  }
  console.log(JSON.stringify({ passed: true, cases, realPrivateProjection: true, actualPageConsumersAndActions: true,
    networkCalls: 0, databaseWrites: 0, paidCalls: 0, browserTests: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
