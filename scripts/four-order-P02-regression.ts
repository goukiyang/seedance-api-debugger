import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ASSET_HOVER_DWELL_MS,
  AssetPlaybackCoordinator,
  getAssetCardClickAction,
  releaseAssetMediaSource,
  replaceAssetMedia,
  settleAssetHoverPlay,
  type AssetPlaybackBoundary,
} from '../src/lib/media/asset-playback';

class MockMedia {
  paused = true;
  src = '/preview.mp4';
  childSources = ['/preview-low.mp4'];
  pauses = 0;
  loads = 0;
  historyWrites = 0;

  pause() { this.paused = true; this.pauses += 1; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loads += 1; }
  querySelectorAll() { return this.childSources.map((_, index) => ({ removeAttribute: () => { this.childSources[index] = ''; } })); }
}

function releaseMock(media: MockMedia, reason: AssetPlaybackBoundary, reasons: AssetPlaybackBoundary[]) {
  media.pause();
  media.removeAttribute('src');
  media.childSources = media.childSources.map(() => '');
  media.load();
  reasons.push(reason);
}

async function main() {
  assert.equal(ASSET_HOVER_DWELL_MS, 150);

  const actions = { open: 0, select: 0 };
  const dispatchClick = (input: Parameters<typeof getAssetCardClickAction>[0]) => {
    const action = getAssetCardClickAction(input);
    actions[action] += 1;
  };
  dispatchClick({ selectionMode: false });
  dispatchClick({ selectionMode: false, shiftKey: true });
  dispatchClick({ selectionMode: false, metaKey: true });
  dispatchClick({ selectionMode: false, ctrlKey: true });
  dispatchClick({ selectionMode: true });
  assert.deepEqual(actions, { open: 1, select: 4 });

  const coordinator = new AssetPlaybackCoordinator();
  const first = new MockMedia();
  const second = new MockMedia();
  const released: AssetPlaybackBoundary[] = [];
  const detailOrder: string[] = [];
  let resolveLatePlay!: () => void;
  const latePlay = new Promise<void>(resolve => { resolveLatePlay = resolve; });
  const firstLease = coordinator.claimHover('video-1', first.src, first, reason => releaseMock(first, reason, released));
  assert.notEqual(firstLease, null);
  const secondLease = coordinator.claimHover('video-2', second.src, second, reason => {
    releaseMock(second, reason, released);
    if (reason === 'detail-play') detailOrder.push('hover-paused');
  });
  assert.notEqual(secondLease, null);
  assert.equal(first.paused, true);
  assert.equal(first.src, '');
  assert.deepEqual(first.childSources, ['']);
  second.paused = false;
  assert.equal(Number(first.paused) + Number(second.paused), 1);

  resolveLatePlay();
  await latePlay.then(() => {
    if (!coordinator.isHoverCurrent(firstLease as number, 'video-1', '/preview.mp4', first)) {
      first.pause();
      releaseMock(first, 'superseded', released);
    }
  });
  assert.equal(first.paused, true);
  assert.equal(coordinator.isHoverCurrent(secondLease as number, 'video-2', second.src, second), true);

  const detail = new MockMedia();
  detail.paused = false;
  const detailLease = coordinator.claimDetail('video-2', '/detail.mp4', detail);
  detailOrder.push('detail-claimed');
  assert.equal(second.paused, true);
  assert.equal(Number(!second.paused) + Number(!detail.paused), 1);
  assert.deepEqual(detailOrder, ['hover-paused', 'detail-claimed']);
  const blockedHover = coordinator.claimHover('video-3', '/other.mp4', new MockMedia(), () => undefined);
  assert.equal(blockedHover, null);

  detail.paused = true;
  coordinator.releaseDetail(detailLease, 'video-2', '/detail.mp4', detail);
  const newerDetail = new MockMedia();
  newerDetail.paused = false;
  const newerLease = coordinator.claimDetail('video-4', '/new-detail.mp4', newerDetail);
  assert.equal(coordinator.releaseDetail(detailLease, 'video-2', '/detail.mp4', detail), false);
  assert.equal(coordinator.isDetailCurrent(newerLease, 'video-4', '/new-detail.mp4', newerDetail), true);
  newerDetail.paused = true;
  assert.equal(coordinator.releaseDetail(newerLease, 'video-4', '/new-detail.mp4', newerDetail), true);

  for (const failed of [false, true]) {
    const media = new MockMedia();
    const owner = new AssetPlaybackCoordinator();
    let currentLease: number | null = null;
    const release = () => { currentLease = null; releaseAssetMediaSource(media); };
    const oldLease = owner.claimHover('same', '/preview.mp4', media, release)!;
    currentLease = oldLease;
    let settle!: () => void;
    const pending = new Promise<void>((resolve, reject) => { settle = () => failed ? reject(new Error('old play rejected')) : resolve(); });
    const finish = (rejected: boolean) => {
      return settleAssetHoverPlay({ media, currentMedia: media, lease: oldLease, currentLease,
        isCurrent: owner.isHoverCurrent(oldLease, 'same', '/preview.mp4', media), keepPlaying: true,
        failed: rejected, stop: reason => { owner.releaseHover(oldLease, 'same', '/preview.mp4', media, reason); },
      });
    };
    const completion = pending.then(() => finish(false), () => finish(true));
    owner.stopHover('mouseleave');
    media.src = '/preview.mp4';
    const newLease = owner.claimHover('same', '/preview.mp4', media, release)!;
    currentLease = newLease;
    media.paused = false;
    const pauses = media.pauses, loads = media.loads;
    settle();
    assert.equal(await completion, 'stale');
    assert.equal(media.pauses, pauses, 'late old play completion cannot pause the newer same-element lease');
    assert.equal(media.loads, loads, 'late old play completion cannot remove the newer source');
    assert.equal(media.src, '/preview.mp4');
    assert.equal(owner.isHoverCurrent(newLease, 'same', '/preview.mp4', media), true);
    owner.stopAll('unmount');
  }
  const detached = new MockMedia();
  const drawerOwner = new AssetPlaybackCoordinator();
  let drawerLease: number | null = drawerOwner.claimDetail('detail', detached.src, detached);
  let ref: MockMedia | null = detached;
  let saved = 0;
  ref = replaceAssetMedia(ref, null, media => {
    saved++;
    drawerOwner.releaseDetail(drawerLease!, 'detail', '/preview.mp4', media);
    drawerLease = null;
  });
  assert.equal(ref, null, 'callback ref detachment releases before the ref becomes null');
  assert.equal(saved, 1, 'active detail position saved once');
  assert.equal(drawerLease, null);
  assert.equal(detached.src, '');
  assert.equal(detached.loads, 1);
  replaceAssetMedia(ref, null, () => { saved++; });
  assert.equal(saved, 1, 'later ref-null cleanup cannot double-write history');

  const rejected = new MockMedia();
  let posterRestored = false;
  assert.equal(settleAssetHoverPlay({ media: rejected, currentMedia: rejected, lease: 1, currentLease: 1,
    isCurrent: true, keepPlaying: true, failed: true, stop: reason => {
      assert.equal(reason, 'error'); releaseAssetMediaSource(rejected); posterRestored = true;
    },
  }), 'released');
  assert.equal(posterRestored, true, 'current play rejection restores the poster and releases its source');

  const boundaries: AssetPlaybackBoundary[] = [
    'mouseleave', 'offscreen', 'hidden', 'filter', 'page', 'view', 'source', 'account',
    'unmount', 'selection', 'drawer-close', 'modal', 'pointer-mode', 'reduced-motion', 'ended', 'error',
  ];
  for (const boundary of boundaries) {
    const media = new MockMedia();
    const reasons: AssetPlaybackBoundary[] = [];
    const owner = new AssetPlaybackCoordinator();
    const lease = owner.claimHover(boundary, media.src, media, reason => releaseMock(media, reason, reasons));
    assert.notEqual(lease, null, `${boundary} starts with a hover lease`);
    owner.stopHover(boundary);
    assert.equal(media.paused, true, `${boundary} pauses media`);
    assert.equal(media.src, '', `${boundary} removes the active source`);
    assert.deepEqual(media.childSources, [''], `${boundary} removes child sources`);
    assert.equal(media.loads, 1, `${boundary} releases the loading state`);
    assert.deepEqual(reasons, [boundary]);
    assert.equal(owner.isHoverCurrent(lease as number, boundary, '/preview.mp4', media), false);
    assert.equal(media.historyWrites, 0, `${boundary} does not write viewing history`);
  }

  const root = process.cwd();
  const coverSource = readFileSync(resolve(root, 'src/components/InlineVideoCover.tsx'), 'utf8');
  const hoverSource = coverSource.slice(coverSource.indexOf('function HoverVideoCover'));
  const assetsSource = readFileSync(resolve(root, 'src/app/assets/page.tsx'), 'utf8');
  const mediaSource = readFileSync(resolve(root, 'src/components/AssetPreviewMedia.tsx'), 'utf8');
  const cssSource = readFileSync(resolve(root, 'src/components/InlineVideoCover.module.css'), 'utf8');

  assert.doesNotMatch(hoverSource, /onClick|onKeyDown|stopPropagation/);
  assert.doesNotMatch(hoverSource, /useMediaPreviewState|\.update\(/);
  assert.match(hoverSource, /src=\{active \? src \|\| undefined : undefined\}/);
  assert.match(hoverSource, /preload="none"[\s\S]*?muted[\s\S]*?loop/);
  assert.match(assetsSource, /interaction="hover"/);
  assert.match(assetsSource, /handleCardKeyDown\(event, item\)/);
  assert.match(assetsSource, /getAssetCardClickAction/);
  assert.match(assetsSource, /AssetPreviewMedia/);
  assert.match(mediaSource, /useMediaPreviewState\(contentKey, contentKey, src\)/);
  assert.match(mediaSource, /onTimeUpdate=\{event => onTimeUpdate/);
  assert.match(mediaSource, /if \(!media\.paused\) return/);
  assert.match(mediaSource, /currentTarget\.ended/);
  assert.match(mediaSource, /replaceAssetMedia\(mediaRef.current, media/);
  assert.match(hoverSource, /settleAssetHoverPlay/);
  assert.match(cssSource, /object-fit: contain/);

  process.stdout.write('P02 isolated source and mocked coordination fixture completed.\n');
}

void main();
