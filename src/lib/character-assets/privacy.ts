/** Private directory references are not part of project/public task DTOs. The owner status endpoint opts in explicitly. */
export function hasCharacterAssetReferences(task: { source_metadata_json?: unknown; params_json?: unknown; reference_image_urls?: unknown; first_frame_url?: unknown; last_frame_url?: unknown; frame_image_urls?: unknown }): boolean {
  return typeof task.source_metadata_json === 'string' && /"private_character_assets"\s*:\s*true/.test(task.source_metadata_json)
    || typeof task.params_json === 'string' && /"kind"\s*:\s*"ark_asset"/.test(task.params_json)
    || [task.reference_image_urls, task.first_frame_url, task.last_frame_url, task.frame_image_urls].some(value => typeof value === 'string' && value.includes('asset://'));
}

export function projectCharacterAssetTask<T extends object>(task: T): T {
  const source = task as Record<string, unknown>;
  if (!hasCharacterAssetReferences(source)) return task;
  const result = { ...source };
  for (const field of ['params_json', 'snapshot', 'provider_payload_json', 'content_json', 'asset_mapping_json',
    'raw_create_response', 'raw_status_response', 'characterAssetReferences', 'character_asset_references', 'reference_image_inputs']) {
    if (field in result) result[field] = null;
  }
  for (const field of ['reference_image_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls']) {
    if (typeof result[field] !== 'string') continue;
    if (!String(result[field]).includes('asset://')) continue;
    try { const urls = JSON.parse(String(result[field])); result[field] = Array.isArray(urls) ? JSON.stringify(urls.filter(url => typeof url === 'string' && !url.startsWith('asset://'))) : null; }
    catch { result[field] = null; }
  }
  if (typeof result.error_message === 'string') result.error_message = result.error_message.replace(/(?:asset:\/\/)?asset-[A-Za-z0-9_-]+/g, '私域角色');
  return result as T;
}
