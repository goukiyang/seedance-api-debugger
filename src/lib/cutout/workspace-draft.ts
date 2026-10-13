// Only local image bytes and view context are retained. No URLs or executable requests.
import type { Box, CharacterBox, PromptOverride } from './types';

export type CutoutWorkspaceDraft = {
  version: 1;
  savedAt: number;
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

export async function readCutoutWorkspaceDraft(accountId: string): Promise<CutoutWorkspaceDraft | null> {
  const value = await transaction<CutoutWorkspaceDraft | undefined>(accountId, 'readonly', store => store.get(accountId));
  if (!value) return null;
  if (!validDraft(value)) {
    throw new Error('本机草稿已过期或无法读取，原草稿保留；服务器结果仍保留');
  }
  return value;
}

export async function saveCutoutWorkspaceDraft(accountId: string, value: CutoutWorkspaceDraft): Promise<void> {
  if (!validDraft(value)) throw new Error('草稿内容无法安全保存');
  const bytes = (value.source?.file?.size || 0) + (value.repair?.result.size || 0) + (value.repair?.mask.size || 0);
  if (bytes > MAX_BYTES) throw new Error('草稿超过本机 64 MB 上限，请先下载修复结果');
  const estimate = await navigator.storage?.estimate?.();
  // Replacement may temporarily need both records; keep the existing draft on failure.
  if (estimate?.quota && estimate.usage != null && estimate.quota - estimate.usage < bytes) throw new Error('本机空间不足，请先下载修复结果');
  await transaction(accountId, 'readwrite', store => store.put(value, accountId));
}

export async function clearCutoutWorkspaceDraft(accountId: string): Promise<void> {
  await transaction(accountId, 'readwrite', store => store.delete(accountId));
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
