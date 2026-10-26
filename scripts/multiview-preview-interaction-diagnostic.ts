import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildAllMultiviewPreviews } from '../src/lib/video/multiview-preview';
import type { MultiviewPreviewManifest } from '../src/lib/video/multiview-preview-contract';
import type { clientDiagnostic, MultiviewPreviewDiagnosticSample } from './fixtures/multiview-preview-interaction-client';

const exec = promisify(execFile);
const localRequire = createRequire(path.join(process.cwd(), 'package.json'));

async function main() {
  const source = process.argv[2]; const output = process.argv[3];
  if (!source) throw new Error('Pass an existing local video path; no network source or login is created.');
  const sourceBytes = await readFile(source); const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'stream=width,height:format=duration:frame=best_effort_timestamp_time', '-of', 'json', source], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const timestamps: number[] = probe.frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
  if (timestamps.length < 50 || timestamps.length > 600 || timestamps.some(time => !Number.isFinite(time))) throw new Error('This bounded diagnostic requires 50–600 readable frames.');
  const info = { taskId: 'isolated-preview-diagnostic', sourceVersion: sourceSha256, width: probe.streams[0].width,
    height: probe.streams[0].height, duration: Number(probe.format.duration), timestamps };
  const root = await mkdtemp(path.join(os.tmpdir(), 'sd2-mv16-diagnostic-'));
  let browser: any;
  const exact = new Map<number, Buffer>(); const requests = { exactPng: 0, atlasJpeg: 0 };
  let manifest: MultiviewPreviewManifest;
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated multiview diagnostic</title>'); return; }
    if (url.pathname === '/atlas') {
      const index = Number(url.searchParams.get('chunk'));
      if (!Number.isInteger(index) || !manifest.chunks[index]) { response.writeHead(400).end(); return; }
      requests.atlasJpeg++; response.setHeader('Content-Type', 'image/jpeg');
      response.end(await readFile(path.join(root, 'preview-v1', 'chunk-' + String(index).padStart(4, '0') + '.jpg'))); return;
    }
    if (url.pathname === '/old') {
      const frame = Number(url.searchParams.get('frame'));
      if (!Number.isInteger(frame) || frame < 0 || frame >= timestamps.length) { response.writeHead(400).end(); return; }
      requests.exactPng++;
      if (!exact.has(frame)) {
        const result = await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-i', source,
          '-an', '-sn', '-dn', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-fps_mode', 'vfr', '-filter_threads', '1', '-threads', '1',
          '-compression_level', '3', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
        exact.set(frame, result.stdout);
      }
      response.setHeader('Content-Type', 'image/png'); response.end(exact.get(frame)); return;
    }
    response.writeHead(404).end();
  })().catch(error => { response.writeHead(500).end(String(error instanceof Error ? error.message : error)); }); });
  try {
    manifest = await buildAllMultiviewPreviews({ source, dir: root, info, signal: AbortSignal.timeout(60000) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local diagnostic port.');
    const esbuild = localRequire('esbuild');
    const bundle = await esbuild.build({ entryPoints: [path.join(process.cwd(), 'scripts/fixtures/multiview-preview-interaction-client.ts')],
      bundle: true, platform: 'browser', format: 'iife', globalName: 'MVPreviewDiagnostic', write: false });
    const { chromium } = localRequire(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto('http://127.0.0.1:' + address.port); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const parameters = JSON.stringify({ manifest, exactWidth: info.width, exactHeight: info.height });
    const result: Awaited<ReturnType<typeof clientDiagnostic>> = await page.evaluate('window.MVPreviewDiagnostic.clientDiagnostic(' + parameters + ')');
    if (result.finalFrame !== result.expectedFinalFrame || result.retainedTiles > 24 || result.retainedAtlases > 2) throw new Error('Latest target or bounded cache failed.');
    const summarize = (samples: MultiviewPreviewDiagnosticSample[]) => { const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b); return { n: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] }; };
    const report = { evidence: 'isolated_same_media_equivalent_comparison', sourceSha256, width: info.width, height: info.height, frames: timestamps.length,
      account: 'none', productionWrites: 0, previewPreparationOutsideTiming: true,
      cacheLayers: { oldCold: 'exact PNG absent in client and local frame service', newCold: 'per-frame JPEG absent; first atlas miss is reported per sample',
        cached: 'same 0–15 frames already decoded in the corresponding client cache', adjacent: 'same 16–23 frames absent; new path reuses decoded atlas 0' },
      requests, oldCold: summarize(result.oldCold), oldCached: summarize(result.oldCached), oldAdjacent: summarize(result.oldAdjacent),
      newCold: summarize(result.newCold), newAdjacent: summarize(result.newAdjacent), newCached: summarize(result.newCached), raw: result,
      limitation: 'Local equivalent controller with the real preview encoder and latest-target gate; excludes production network/auth, full React page, and user Chrome. Not user-page p95.' };
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
