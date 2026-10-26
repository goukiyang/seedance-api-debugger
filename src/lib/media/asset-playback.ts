export type AssetPlaybackBoundary =
  | 'mouseleave'
  | 'offscreen'
  | 'hidden'
  | 'filter'
  | 'page'
  | 'view'
  | 'source'
  | 'account'
  | 'unmount'
  | 'selection'
  | 'drawer-close'
  | 'modal'
  | 'pointer-mode'
  | 'reduced-motion'
  | 'superseded'
  | 'detail-play'
  | 'ended'
  | 'error';

export type AssetPlaybackLease = number;
export type AssetPlaybackMedia = Pick<HTMLMediaElement, 'paused' | 'pause'>;
export type ReleaseAssetHover = (reason: AssetPlaybackBoundary) => void;
export const ASSET_HOVER_DWELL_MS = 150;

type AssetSourceMedia = {
  pause: () => void;
  removeAttribute: (name: string) => void;
  querySelectorAll: (selector: string) => Iterable<{ removeAttribute: (name: string) => void }>;
  load: () => void;
};

export function releaseAssetMediaSource(media: AssetSourceMedia) {
  media.pause();
  media.removeAttribute('src');
  for (const source of Array.from(media.querySelectorAll('source'))) source.removeAttribute('src');
  try { media.load(); } catch { /* Detached media may already be unavailable. */ }
}

export function settleAssetHoverPlay(input: {
  media: AssetSourceMedia; currentMedia: AssetSourceMedia | null;
  lease: AssetPlaybackLease; currentLease: AssetPlaybackLease | null;
  isCurrent: boolean; keepPlaying: boolean; failed: boolean;
  stop: (reason: AssetPlaybackBoundary) => void;
}) {
  // An old play promise must never pause a newer lease on the same element.
  if (input.currentMedia !== input.media) { releaseAssetMediaSource(input.media); return 'stale'; }
  if (input.currentLease !== input.lease) return 'stale';
  if (!input.failed && input.isCurrent && input.keepPlaying) return 'kept';
  input.stop(input.failed ? 'error' : 'superseded');
  return 'released';
}

export function replaceAssetMedia<T extends AssetSourceMedia>(previous: T | null, next: T | null, release: (media: T) => void) {
  if (previous && previous !== next) {
    release(previous);
    releaseAssetMediaSource(previous);
  }
  return next;
}

type PlaybackOwnerBase = {
  key: string;
  src: string;
  media: AssetPlaybackMedia;
  lease: AssetPlaybackLease;
};

type PlaybackOwner = (PlaybackOwnerBase & {
  kind: 'hover';
  release: ReleaseAssetHover;
}) | (PlaybackOwnerBase & {
  kind: 'detail';
});

export class AssetPlaybackCoordinator {
  private epoch = 0;
  private owner: PlaybackOwner | null = null;
  private modalBlocked = false;

  claimHover(key: string, src: string, media: AssetPlaybackMedia, release: ReleaseAssetHover) {
    if (!src || this.modalBlocked) return null;
    if (this.owner?.kind === 'detail' && !this.owner.media.paused) return null;

    this.stopOwner('superseded');
    const lease = ++this.epoch;
    this.owner = { kind: 'hover', key, src, media, lease, release };
    return lease;
  }

  claimDetail(key: string, src: string, media: AssetPlaybackMedia) {
    this.stopOwner('detail-play');
    const lease = ++this.epoch;
    this.owner = { kind: 'detail', key, src, media, lease };
    return lease;
  }

  isHoverCurrent(lease: AssetPlaybackLease, key: string, src: string, media: AssetPlaybackMedia) {
    return this.matches('hover', lease, key, src, media);
  }

  isDetailCurrent(lease: AssetPlaybackLease, key: string, src: string, media: AssetPlaybackMedia) {
    return this.matches('detail', lease, key, src, media);
  }

  releaseHover(lease: AssetPlaybackLease, key: string, src: string, media: AssetPlaybackMedia, reason: AssetPlaybackBoundary) {
    if (!this.matches('hover', lease, key, src, media)) return false;
    this.stopOwner(reason);
    return true;
  }

  releaseDetail(lease: AssetPlaybackLease, key: string, src: string, media: AssetPlaybackMedia) {
    if (!this.matches('detail', lease, key, src, media)) return false;
    this.owner = null;
    this.epoch += 1;
    return true;
  }

  stopHover(reason: AssetPlaybackBoundary) {
    if (this.owner?.kind !== 'hover') return;
    this.stopOwner(reason);
  }

  stopAll(reason: AssetPlaybackBoundary) {
    this.stopOwner(reason);
  }

  setModalBlocked(blocked: boolean) {
    this.modalBlocked = blocked;
    if (blocked) this.stopAll('modal');
  }

  private matches(kind: PlaybackOwner['kind'], lease: AssetPlaybackLease, key: string, src: string, media: AssetPlaybackMedia) {
    const owner = this.owner;
    return owner?.kind === kind && owner.lease === lease && owner.key === key && owner.src === src && owner.media === media;
  }

  private stopOwner(reason: AssetPlaybackBoundary) {
    const owner = this.owner;
    if (!owner) return;
    this.owner = null;
    this.epoch += 1;
    try {
      if (owner.kind === 'hover') owner.release(reason);
      else owner.media.pause();
    } catch {
      try { owner.media.pause(); } catch { /* A detached player may already be unavailable. */ }
    }
  }
}

export function getAssetCardClickAction(input: {
  selectionMode: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}) {
  return input.selectionMode || input.shiftKey || input.metaKey || input.ctrlKey ? 'select' : 'open';
}
