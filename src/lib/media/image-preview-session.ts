'use client';

import { acquireImageRead, beginImageForegroundPreparation, captureImageReadSessionScope, resetImageReadForRetry, setImageReadSessionOwner, type ImageReadResult } from './image-read-session';
import { acquireHdImageSource, hdImageHint, refreshHdImageSource, type HdDescription, type HdSourceState } from './hd-source-session';
import { hdDescriptionUsesOriginal, type HdDisplayKind } from './hd-display-policy';
import { imageDisplaySource } from './image-comparison';
import { versionedHdSource } from '@/lib/hooks/use-hd-image-source';

export type ImagePreviewPreparationOptions = { account: string; source: string; sourceVersion?: string; previewOnly?: boolean; original?: boolean };
export type PreparedImagePreviewState = {
  readSource: string; version: string; displayKind: HdDisplayKind; fullSize: boolean;
  description?: HdDescription; descriptorPending: boolean; denied?: boolean; error?: boolean; fallback: boolean; result: ImageReadResult;
};
export type ImagePreviewPreparation = {
  readonly account: string; readonly source: string; readonly sourceVersion: string; readonly previewOnly: boolean; readonly original: boolean;
  getSnapshot: () => PreparedImagePreviewState;
  subscribe: (listener: (state: PreparedImagePreviewState) => void) => () => void;
  isCurrent: () => boolean;
  markDisplayed: () => void;
  /** Relinquish only the initiating click's lease, after the viewer subscribes. */
  release: () => void;
};

const waiting = (): ImageReadResult => ({ imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } });

/** A consumer lease over the existing sessions, never a second cache or queue. */
export function prepareImagePreview(options: ImagePreviewPreparationOptions): ImagePreviewPreparation {
  const { account, source } = options, sourceVersion = options.sourceVersion || '', previewOnly = Boolean(options.previewOnly), original = Boolean(options.original);
  const listeners = new Set<(state: PreparedImagePreviewState) => void>();
  let initialLease = true, disposed = false, readSequence = 0, readKey = '', recovering = false, recovered409 = false, stoppedAutomatic = false;
  let releaseRead: (() => void) | undefined, releaseHd: (() => void) | undefined, releasePriority: (() => void) | undefined;
  let state: PreparedImagePreviewState = { readSource: '', version: sourceVersion, displayKind: 'pending', fullSize: false, descriptorPending: !previewOnly && !original, fallback: false, result: waiting() };
  if (account) setImageReadSessionOwner(account);
  const sameScope = captureImageReadSessionScope(account);
  const notify = () => { for (const listener of Array.from(listeners)) listener(state); };
  const endPriority = () => { releasePriority?.(); releasePriority = undefined; };
  const dispose = () => {
    if (disposed) return;
    disposed = true; initialLease = false; readSequence++;
    releaseRead?.(); releaseRead = undefined; releaseHd?.(); releaseHd = undefined;
    endPriority(); listeners.clear();
  };
  const deny = (message = '图片权限或来源不可用，请重新打开') => {
    if (disposed) return;
    state = { ...state, readSource: '', denied: true, descriptorPending: false, result: { imageSrc: null, denied: true, progress: { phase: 'unavailable', loadedBytes: 0, message } } };
    notify(); dispose();
  };
  const active = () => {
    if (disposed) return false;
    if (!sameScope()) { deny('账号状态已变化，图片读取已取消'); return false; }
    return true;
  };
  const unconfirmed = () => {
    if (!active()) return;
    stoppedAutomatic = true;
    releaseRead?.(); releaseRead = undefined; readSequence++; readKey = '';
    state = { ...state, readSource: '', descriptorPending: false, error: true,
      result: { imageSrc: null, unconfirmed: true, progress: { phase: 'unavailable', loadedBytes: 0, message: '图片版本暂时无法确认，请重试或主动查看原图' } } };
    notify();
  };
  const load = (kind: HdDisplayKind, description?: HdDescription, fallback = false, descriptorError = false) => {
    if (!active() || kind === 'pending') return;
    const readSource = kind === 'hd' ? versionedHdSource(source, 'hd', description?.sourceVersion)
      : imageDisplaySource(source, kind === 'preview' ? 'preview' : 'original');
    const version = kind === 'hd' ? description?.sourceVersion || '' : sourceVersion;
    const key = JSON.stringify([kind, readSource, version]);
    state = { ...state, readSource, version, displayKind: kind, fullSize: kind !== 'preview', description,
      descriptorPending: ['queued', 'running'].includes(description?.status || ''), error: descriptorError, fallback };
    if (key === readKey) { notify(); return; }
    // A later authorized version/representation change becomes foreground
    // again before releasing the old body or allowing any neighbor bytes.
    releasePriority ||= beginImageForegroundPreparation(account);
    readKey = key; const sequence = ++readSequence;
    releaseRead?.(); releaseRead = undefined;
    state = { ...state, result: waiting() }; notify();
    const release = acquireImageRead(account, readSource, version, 0, result => {
      if (!active() || sequence !== readSequence) return;
      if (result.denied) { deny(result.progress.message); return; }
      state = { ...state, result }; notify();
      if (result.refreshSource && kind === 'hd') {
        if (recovered409 || recovering) { if (!recovering) unconfirmed(); return; }
        recovering = true; recovered409 = true;
        void refreshHdImageSource(account, imageDisplaySource(source, 'hd-description'), sourceVersion).then(fresh => {
          if (!active() || sequence !== readSequence) return;
          recovering = false;
          if (fresh.denied) { deny(); return; }
          // A readonly descriptor 409 specifically means no ready derivative;
          // it is not permission to serve cached or unrelated original bytes.
          if (fresh.httpStatus === 409 || fresh.description && fresh.description.status !== 'ready') {
            load('original', fresh.description, true, Boolean(fresh.error)); return;
          }
          if (!fresh.description) { unconfirmed(); return; }
          const nextKind = hdDescriptionUsesOriginal(fresh.description) ? 'original' : 'hd';
          if (nextKind === 'hd') resetImageReadForRetry(versionedHdSource(source, 'hd', fresh.description.sourceVersion), account);
          readKey = ''; load(nextKind, fresh.description, nextKind === 'original', Boolean(fresh.error));
        }).catch(() => { if (active() && sequence === readSequence) { recovering = false; unconfirmed(); } });
        return;
      }
      if (kind === 'hd' && (result.unconfirmed || result.progress.phase === 'unsupported' || result.progress.phase === 'unavailable')) {
        load('original', description, true, descriptorError); return;
      }
    });
    // Cached callbacks can synchronously select another representation. Do not
    // replace that newer consumer's release with this older subscription.
    if (disposed || sequence !== readSequence) release();
    else releaseRead = release;
  };
  const descriptionChanged = (value: HdSourceState) => {
    if (!active() || recovering) return;
    if (value.denied) { deny(); return; }
    if (stoppedAutomatic) return;
    const description = value.description;
    if (description?.status === 'ready') load(hdDescriptionUsesOriginal(description) ? 'original' : 'hd', description, false, Boolean(value.error));
    else if (description) load('original', description, true, Boolean(value.error));
    else if (value.error) {
      if (value.httpStatus === 409) unconfirmed();
      else load('original', undefined, true, true);
    }
  };
  const handle: ImagePreviewPreparation = {
    account, source, sourceVersion, previewOnly, original,
    getSnapshot: () => state,
    isCurrent: () => !disposed && sameScope(),
    subscribe: listener => {
      if (!active()) { listener(state); return () => {}; }
      const consumer = (next: PreparedImagePreviewState) => listener(next);
      listeners.add(consumer); consumer(state);
      let released = false;
      return () => { if (released) return; released = true; listeners.delete(consumer); if (!initialLease && !listeners.size) dispose(); };
    },
    markDisplayed: endPriority,
    release: () => { if (!initialLease) return; initialLease = false; if (!listeners.size) dispose(); },
  };
  if (!account || !source) { deny('请先确认登录状态后重新打开图片'); return handle; }
  releasePriority = beginImageForegroundPreparation(account);
  const descriptionSource = imageDisplaySource(source, 'hd-description');
  const supported = !previewOnly && !original && descriptionSource !== source && !/^(blob:|data:)/i.test(source);
  if (previewOnly || original || !supported) {
    load(previewOnly ? 'preview' : 'original', !previewOnly ? hdImageHint(account, descriptionSource, sourceVersion, true) : undefined);
  } else {
    const release = acquireHdImageSource(account, descriptionSource, sourceVersion, descriptionChanged);
    releaseHd = release; if (disposed) release();
  }
  return handle;
}
