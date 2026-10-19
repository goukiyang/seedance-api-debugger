import { encodeMultiviewPreviewFrame } from '../../src/app/multiview/multiview-preview-image';
import { createMultiviewLatestTargetGate, type MultiviewPreviewManifest } from '../../src/lib/video/multiview-preview-contract';

export type MultiviewPreviewDiagnosticSample = { frame: number; ms: number; exactCacheHit: boolean | null; tileCacheHit: boolean | null; atlasCacheHit: boolean | null };

/** Bundled with its browser dependencies; never serialized out of a Node closure. */
export async function clientDiagnostic(input: { manifest: MultiviewPreviewManifest; exactWidth: number; exactHeight: number }) {
  const { manifest, exactWidth, exactHeight } = input;
  const image = document.createElement('img'); image.width = 320; image.height = 320; document.body.append(image);
  const button = document.createElement('button'); button.textContent = 'next frame'; document.body.append(button);
  const urls = new Set<string>();
  const exact = new Map<number, string>(); const tiles = new Map<number, string>();
  const atlases = new Map<number, ImageBitmap>(); const pending = new Map<number, Promise<ImageBitmap>>();
  const decoded = async (blob: Blob) => {
    const url = URL.createObjectURL(blob); urls.add(url);
    const prepared = new Image(); prepared.src = url; await prepared.decode(); return url;
  };
  const tile = async (frame: number) => {
    if (tiles.has(frame)) return tiles.get(frame)!;
    const index = Math.floor(frame / manifest.chunkSize);
    let bitmap = atlases.get(index);
    if (!bitmap) {
      let request = pending.get(index);
      if (!request) {
        request = fetch('/atlas?chunk=' + index).then(response => response.blob()).then(blob => createImageBitmap(blob));
        pending.set(index, request);
      }
      bitmap = await request; pending.delete(index); atlases.set(index, bitmap);
      while (atlases.size > 2) { const oldest = atlases.keys().next().value!; atlases.get(oldest)!.close(); atlases.delete(oldest); }
    }
    const url = await decoded(await encodeMultiviewPreviewFrame(bitmap, manifest, frame));
    tiles.set(frame, url);
    while (tiles.size > 24) { const oldest = tiles.keys().next().value!; URL.revokeObjectURL(tiles.get(oldest)!); urls.delete(tiles.get(oldest)!); tiles.delete(oldest); }
    return url;
  };
  const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const run = async (mode: 'old' | 'new', frames: number[]) => {
    const samples: MultiviewPreviewDiagnosticSample[] = [];
    for (const frame of frames) {
      await new Promise<void>((resolve, reject) => {
        button.onclick = () => { void (async () => {
          const start = performance.now(); let url: string;
          const cache = { exactCacheHit: mode === 'old' ? exact.has(frame) : null,
            tileCacheHit: mode === 'new' ? tiles.has(frame) : null,
            atlasCacheHit: mode === 'new' ? atlases.has(Math.floor(frame / manifest.chunkSize)) : null };
          if (mode === 'old') {
            // The old slot controller waited 120 ms, then required the exact PNG.
            await new Promise(done => setTimeout(done, 120));
            if (!exact.has(frame)) exact.set(frame, await decoded(await fetch('/old?frame=' + frame).then(response => response.blob())));
            url = exact.get(frame)!;
          } else url = await tile(frame);
          image.src = url; image.dataset.frame = String(frame); await image.decode();
          const width = mode === 'old' ? exactWidth : manifest.cellWidth;
          const height = mode === 'old' ? exactHeight : manifest.cellHeight;
          if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('Displayed frame has the wrong decoded dimensions.');
          await paint();
          if (image.currentSrc !== url || Number(image.dataset.frame) !== frame) throw new Error('Displayed image and frame label diverged.');
          samples.push({ frame, ms: performance.now() - start, ...cache }); resolve();
        })().catch(reject); };
        button.click();
      });
    }
    return samples;
  };
  try {
    const first = Array.from({ length: 16 }, (_, index) => index);
    const adjacent = Array.from({ length: 8 }, (_, index) => index + 16);
    const oldCold = await run('old', first); const newCold = await run('new', first);
    const oldCached = await run('old', first); const newCached = await run('new', first);
    const oldAdjacent = await run('old', adjacent); const newAdjacent = await run('new', adjacent);
    const gate = createMultiviewLatestTargetGate(); const burstFrames = Array.from({ length: 10 }, (_, index) => index + 40);
    await Promise.all(burstFrames.map(async frame => {
      const target = gate.issue(frame); const url = await tile(frame);
      if (gate.isCurrent(target)) { image.src = url; image.dataset.frame = String(frame); }
    }));
    await image.decode(); await paint();
    if (image.naturalWidth !== manifest.cellWidth || image.naturalHeight !== manifest.cellHeight) throw new Error('Final burst image was not decoded at preview size.');
    return { oldCold, oldCached, oldAdjacent, newCold, newAdjacent, newCached, finalFrame: Number(image.dataset.frame),
      expectedFinalFrame: burstFrames.at(-1), retainedTiles: tiles.size, retainedAtlases: atlases.size };
  } finally { for (const url of Array.from(urls)) URL.revokeObjectURL(url); for (const bitmap of Array.from(atlases.values())) bitmap.close(); }
}
