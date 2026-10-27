export type HdReadCursor = { at: string; id: string };
export type HdReadAsset = { id: string; owner_id: string; original_url: string; metadata_json: string | null;
  status: string; type: string };
export type HdDatedAsset = HdReadAsset & { created_at: Date };
export type HdReadReference = { id: string; owner_user_id: string; url: string; status: string; asset_id: string | null; album: { status: string } };
export type HdReadTask = { id: string; owner_id: string; status: string; usage_json: string | null; finished_at: Date | null; asset_id: string | null };
export interface HdReadRepository {
  assetById(id: string): Promise<HdReadAsset | null>;
  referenceById(id: string): Promise<HdReadReference | null>;
  assetsAtUrls(urls: string[]): Promise<HdReadAsset[]>;
  referencesAtUrls(urls: string[]): Promise<HdReadReference[]>;
  nextAssets(cursor: HdReadCursor, captured: Date, take: number): Promise<HdDatedAsset[]>;
  nextTasks(cursor: HdReadCursor, captured: Date, take: number): Promise<HdReadTask[]>;
  taskAsset(id: string, ownerId: string): Promise<HdReadAsset | null>;
  countActiveImageAssets(): Promise<number>;
  inventoryAssets(): Promise<HdDatedAsset[]>;
  inventoryReferences(): Promise<HdReadReference[]>;
  close(): Promise<void>;
}
export function hdReadLimit(take: number) {
  if (!Number.isSafeInteger(take) || take < 1 || take > 100) throw new Error('hd_read_limit_required');
  return take;
}
export function hdReadUrls(urls: string[]) {
  if (!Array.isArray(urls) || urls.length > 16 || urls.some(url => typeof url !== 'string' || !url || url.length > 8192)) throw new Error('hd_read_urls_invalid');
  return [...new Set(urls)];
}
export function hdReadWindow(cursor: HdReadCursor, captured: Date) {
  const at = Date.parse(cursor.at), end = captured.getTime();
  if (!Number.isFinite(at) || !Number.isFinite(end) || typeof cursor.id !== 'string') throw new Error('hd_read_cursor_invalid');
  return { at, end };
}
