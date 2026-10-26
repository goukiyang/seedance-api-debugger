// Only local image bytes and view context are retained. No URLs or executable requests.
import type { Box, CharacterBox, PromptOverride } from './types';

export type CutoutWorkspaceDraft = {
  version: 1;
  savedAt: number;
  storageRevision?: string;
  source: { id: string; file?: Blob; reference?: string; name: string; accepted: boolean; fullCanvas?: boolean; handoffId?: string } | null;
  sourceJobId: string | null;
  repair: { result: Blob; mask: Blob; filename: string; jobId: string; sourceVersion: string } | null;
  editor?: { boxes: CharacterBox[]; prompts: PromptOverride[]; region: Box | null };
};

const DATABASE = 'sd2-cutout-workspace-v1';
const STORE = 'drafts';
const MAX_BYTES = 64 * 1024 * 1024;
const LIFETIME = 7 * 86400_000;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('浏览器无法保存本机草稿')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('本机草稿存储无法打开'));
    request.onblocked = () => reject(new Error('本机草稿存储被其他页面占用'));
  });
}

async function transaction<T>(accountId: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  if (!accountId || accountId.length > 200) throw new Error('未确认账号，暂不保存草稿');
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    tx.oncomplete = () => { database.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { database.close(); reject(new Error('本机草稿未保存，可能空间不足或存储被禁用')); };
  });
}

function validBlob(value: unknown) {
  return value instanceof Blob && value.size > 0 && ['image/png', 'image/jpeg', 'image/webp'].includes(value.type);
}

function validDraft(value: CutoutWorkspaceDraft) {
  const validBox = (box: Box) => box && [box.x, box.y, box.w, box.h].every(number => Number.isFinite(number) && number >= 0 && number <= 32000) && box.w > 0 && box.h > 0;
  const validEditor = !value?.editor || (Array.isArray(value.editor.boxes) && value.editor.boxes.length <= 256
    && value.editor.boxes.every(box => validBox(box) && typeof box.id === 'string' && box.id.length <= 128 && typeof box.name === 'string' && box.name.length <= 80)
    && Array.isArray(value.editor.prompts) && value.editor.prompts.length <= 256
    && value.editor.prompts.every(prompt => typeof prompt.id === 'string' && prompt.id.length <= 128 && Array.isArray(prompt.points) && prompt.points.length <= 1024
      && Array.isArray(prompt.labels) && prompt.labels.length === prompt.points.length && prompt.labels.every(label => label === 0 || label === 1)
      && prompt.points.every(point => Array.isArray(point) && point.length === 2 && point.every(number => Number.isFinite(number) && number >= 0 && number <= 32000)))
    && (!value.editor.region || validBox(value.editor.region)));
  return value?.version === 1 && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() + 60_000
    && (value.storageRevision === undefined || typeof value.storageRevision === 'string' && /^[\w-]{16,128}$/.test(value.storageRevision))
    && Date.now() - value.savedAt <= LIFETIME
    && validEditor
    && (!value.source || (/^[\w-]{1,128}$/.test(value.source.id) && (validBlob(value.source.file)
      || typeof value.source.reference === 'string' && /^\/api\/v1\/results\/[\w-]{1,128}\/[\w.%\-\u4e00-\u9fff]{1,500}$/.test(value.source.reference) && !value.source.reference.includes('..'))
      && typeof value.source.name === 'string' && value.source.name.length <= 240
      && (!value.source.handoffId || /^[a-f0-9]{64}$/.test(value.source.handoffId))))
    && (!value.sourceJobId || /^[\w-]{1,128}$/.test(value.sourceJobId))
    && (!value.repair || (validBlob(value.repair.result) && validBlob(value.repair.mask)
      && /^[\w-]{1,128}$/.test(value.repair.jobId) && typeof value.repair.sourceVersion === 'string'
      && value.repair.sourceVersion.length <= 500 && typeof value.repair.filename === 'string' && value.repair.filename.length <= 240));
}

type DraftSlot = 'current' | 'previous';
const draftKey = (accountId: string, slot: DraftSlot) => slot === 'current' ? accountId : ['previous', accountId];
const draftBytes = (value: CutoutWorkspaceDraft | null | undefined) => (value?.source?.file?.size || 0) + (value?.repair?.result.size || 0) + (value?.repair?.mask.size || 0);
const newStorageRevision = () => globalThis.crypto.randomUUID?.()
  || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

// IndexedDB clones Blobs, so object identity cannot establish that an older
// workspace is redundant. Compare the retained content, with bounded byte reads.
export async function cutoutWorkspaceDraftContentEqual(left: CutoutWorkspaceDraft, right: CutoutWorkspaceDraft, isCurrent: () => boolean): Promise<boolean> {
  const box = (value: Box | null | undefined) => value ? [value.x, value.y, value.w, value.h] : null;
  const content = (value: CutoutWorkspaceDraft) => [
    value.source ? [value.source.id, value.source.reference ?? null, value.source.name, value.source.accepted,
      value.source.fullCanvas === true, value.source.handoffId ?? null] : null,
    value.sourceJobId,
    value.repair ? [value.repair.filename, value.repair.jobId, value.repair.sourceVersion] : null,
    (value.editor?.boxes || []).map(value => [value.id, value.name, box(value)]),
    (value.editor?.prompts || []).map(value => [value.id, value.points, value.labels, value.mask_index ?? null]),
    box(value.editor?.region),
  ];
  const sameBlob = async (a: Blob | undefined, b: Blob | undefined) => {
    if (!a || !b) return !a && !b;
    if (a.size !== b.size || a.type !== b.type) return false;
    const chunkBytes = 256 * 1024;
    for (let offset = 0; offset < a.size; offset += chunkBytes) {
      if (!isCurrent()) return false;
      const [aChunk, bChunk] = await Promise.all([
        a.slice(offset, offset + chunkBytes).arrayBuffer(), b.slice(offset, offset + chunkBytes).arrayBuffer(),
      ]);
      if (!isCurrent()) return false;
      const aBytes = new Uint8Array(aChunk), bBytes = new Uint8Array(bChunk);
      if (aBytes.length !== bBytes.length || aBytes.some((byte, index) => byte !== bBytes[index])) return false;
    }
    return true;
  };
  try {
    if (!isCurrent() || !validDraft(left) || !validDraft(right) || draftBytes(left) > MAX_BYTES || draftBytes(right) > MAX_BYTES
      || JSON.stringify(content(left)) !== JSON.stringify(content(right))) return false;
    return await sameBlob(left.source?.file, right.source?.file)
      && await sameBlob(left.repair?.result, right.repair?.result)
      && await sameBlob(left.repair?.mask, right.repair?.mask)
      && isCurrent();
  } catch {
    // Unreadable bytes are not proof that the unique older workspace is safe to replace.
    return false;
  }
}

export async function readCutoutWorkspaceDraft(accountId: string, slot: DraftSlot = 'current'): Promise<CutoutWorkspaceDraft | null> {
  const value = await transaction<CutoutWorkspaceDraft | undefined>(accountId, 'readonly', store => store.get(draftKey(accountId, slot)));
  if (!value) return null;
  if (!validDraft(value)) {
    throw new Error('本机草稿已过期或无法读取，原草稿保留；服务器结果仍保留');
  }
  return value;
}

export async function saveCutoutWorkspaceDraft(accountId: string, value: CutoutWorkspaceDraft, slot: DraftSlot = 'current', guard?: { expectedRevision: string | null; isCurrent: () => boolean }): Promise<void> {
  if (!validDraft(value)) throw new Error('草稿内容无法安全保存');
  if (!accountId || accountId.length > 200) throw new Error('未确认账号，暂不保存草稿');
  const bytes = draftBytes(value);
  if (bytes > MAX_BYTES) throw new Error('草稿超过本机 64 MB 上限，请先下载修复结果');
  const estimate = await navigator.storage?.estimate?.();
  // Replacement may temporarily need both records; keep the existing draft on failure.
  if (estimate?.quota && estimate.usage != null && estimate.quota - estimate.usage < bytes) throw new Error('本机空间不足，请先下载修复结果');
  const storageRevision = newStorageRevision();
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let failure = '本机草稿未保存，可能空间不足或存储被禁用';
    const other = store.get(draftKey(accountId, slot === 'current' ? 'previous' : 'current'));
    other.onsuccess = () => {
      const retained = other.result as CutoutWorkspaceDraft | undefined;
      if (retained && validDraft(retained) && bytes + draftBytes(retained) > MAX_BYTES) {
        failure = '当前与上次草稿合计超过本机 64 MB 上限，请先下载需要保留的结果';
        tx.abort();
        return;
      }
      const write = () => store.put({ ...value, storageRevision }, draftKey(accountId, slot));
      if (!guard) { write(); return; }
      const target = store.get(draftKey(accountId, slot));
      target.onsuccess = () => {
        if (!guard.isCurrent() || (target.result?.storageRevision || null) !== guard.expectedRevision) {
          failure = '上次草稿已在其他页面变化，尚未切换，请重新选择';
          tx.abort();
          return;
        }
        write();
      };
    };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onerror = tx.onabort = () => { database.close(); reject(new Error(failure)); };
  });
}

export async function clearCutoutWorkspaceDraft(accountId: string): Promise<void> {
  await transaction(accountId, 'readwrite', store => store.delete(accountId));
}

// Swap only the draft that was read and authorized; a different tab must not retarget recovery.
export async function swapCutoutWorkspaceDraft(accountId: string, expected: CutoutWorkspaceDraft, isCurrent: () => boolean): Promise<void> {
  if (!expected.storageRevision) throw new Error('旧草稿缺少恢复标识，尚未切换，请先重新保留草稿');
  const currentRevision = newStorageRevision(), previousRevision = newStorageRevision();
  await transaction(accountId, 'readwrite', store => {
    const request = store.get(draftKey(accountId, 'previous'));
    request.onsuccess = () => {
      const previous = request.result as CutoutWorkspaceDraft | undefined;
      if (!isCurrent() || !previous || !validDraft(previous) || previous.storageRevision !== expected.storageRevision) {
        store.transaction.abort();
        return;
      }
      const current = store.get(accountId);
      current.onsuccess = () => {
        if (!isCurrent()) { store.transaction.abort(); return; }
        if (current.result) store.put({ ...current.result, storageRevision: previousRevision }, draftKey(accountId, 'previous'));
        else store.delete(draftKey(accountId, 'previous'));
        store.put({ ...previous, storageRevision: currentRevision }, accountId);
      };
    };
    return request;
  });
}

export type CutoutViewPreferences = {
  view: 'original' | 'result' | 'compare';
  background: 'checker' | 'light' | 'dark';
  adjustmentsOpen: boolean;
  characterOpen: boolean;
  outputId: string;
  characterSettings?: { strategy: string; background_distance_threshold: number; min_component_area: number; padding: number; max_components: number };
};

export function readCutoutViewPreferences(accountId: string): Partial<CutoutViewPreferences> {
  try {
    const value = JSON.parse(localStorage.getItem(`sd2:cutout:view:v1:${accountId}`) || 'null');
    if (value?.version !== 1) return {};
    const character = value.characterSettings;
    const number = (input: unknown, min: number, max: number, fallback: number) => typeof input === 'number' && Number.isFinite(input) ? Math.min(max, Math.max(min, Math.round(input))) : fallback;
    return {
      view: ['original', 'result', 'compare'].includes(value.view) ? value.view : 'result',
      background: ['checker', 'light', 'dark'].includes(value.background) ? value.background : 'checker',
      adjustmentsOpen: value.adjustmentsOpen === true,
      characterOpen: value.characterOpen === true,
      outputId: typeof value.outputId === 'string' && value.outputId.length <= 240 ? value.outputId : '',
      ...(character && typeof character === 'object' ? { characterSettings: {
        strategy: character.strategy === 'sam_box' ? 'sam_box' : 'model_mask',
        background_distance_threshold: number(character.background_distance_threshold, 2, 128, 20),
        min_component_area: number(character.min_component_area, 16, 2000000, 1200),
        padding: number(character.padding, 0, 512, 20), max_components: number(character.max_components, 1, 256, 64),
      } } : {}),
    };
  } catch { return {}; }
}

export function saveCutoutViewPreferences(accountId: string, value: CutoutViewPreferences): boolean {
  try { localStorage.setItem(`sd2:cutout:view:v1:${accountId}`, JSON.stringify({ version: 1, ...value })); return true; }
  catch { return false; }
}
