import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';

// Logical bytes of attributable plugin records and recorded original attachments.
// Never scan other users' files or attribute a shared database/backup to an account.
export async function readBridgeStorageUsage(userId: string) {
  const rows = await prisma.$queryRaw<Array<{ kind: string; bytes: bigint | number; records: bigint | number; reference: string | null }>>`
    WITH plugin_feedback AS (
      SELECT f.* FROM "Feedback" f
      WHERE f.user_id = ${userId} AND EXISTS (
        SELECT 1 FROM "PlatformSetting" s WHERE s.key = 'feedback-source:v1:' || f.id
          AND s.updated_by = ${userId}
          AND json_extract(CASE WHEN json_valid(s.value_json) THEN s.value_json ELSE '{}' END, '$.site') IN ('chatgpt','midjourney','jimeng')
      )
    ), plugin_notifications AS (
      SELECT n.* FROM "Notification" n WHERE
        (n.type = 'bridge_feishu_v1' AND n.target_user_id = ${userId}) OR
        (n.type IN ('feedback_feishu_v1','feedback_ack_feishu_v1') AND
          json_extract(CASE WHEN json_valid(n.metadata_json) THEN n.metadata_json ELSE '{}' END, '$.feedbackId') IN (SELECT id FROM plugin_feedback))
    ), referenced_urls AS (
      SELECT j.value AS url FROM plugin_feedback f,
        json_each(CASE WHEN json_valid(f.image_urls_json) THEN f.image_urls_json ELSE '[]' END) j WHERE j.type = 'text'
      UNION
      SELECT j.value FROM "BridgeQueuePreset" p,
        json_tree(CASE WHEN json_valid(p.items_json) THEN p.items_json ELSE '[]' END) j
        WHERE p.owner_id = ${userId} AND j.key = 'url' AND j.type = 'text'
    ), referenced_ids AS (
      SELECT json_extract(j.value, '$.id') AS asset_id FROM plugin_notifications n,
        json_each(CASE WHEN json_valid(n.metadata_json) THEN n.metadata_json ELSE '{}' END, '$.assets') j
        WHERE n.type = 'bridge_feishu_v1' AND j.type = 'object'
      UNION
      SELECT json_extract(j.value, '$.assetId') FROM plugin_notifications n,
        json_each(CASE WHEN json_valid(n.metadata_json) THEN n.metadata_json ELSE '{}' END, '$.preparation.attachments.items') j
        WHERE n.type IN ('feedback_feishu_v1','feedback_ack_feishu_v1') AND j.type = 'object'
    ), payloads AS (
      SELECT CASE WHEN substr(p.key,1,length('bridge_gpt_directory_v1:')) = 'bridge_gpt_directory_v1:' THEN 'directory' WHEN substr(p.key,1,18) = 'bridge_gpt_review_' THEN 'reviews' ELSE 'settings' END AS kind,
        length(CAST(p.key AS BLOB)) + length(CAST(p.value_json AS BLOB)) AS bytes
      FROM "UserPreference" p WHERE p.user_id = ${userId} AND
        (substr(p.key,1,length('bridge_gpt_directory_v1:')) = 'bridge_gpt_directory_v1:' OR substr(p.key,1,18) = 'bridge_gpt_review_' OR p.key IN ('bridge_devices_v1','bridge.feishu.rate.v1'))
      UNION ALL
      SELECT 'presets', length(CAST(p.id || p.owner_id || p.name || p.items_json || COALESCE(p.client_id,'') || COALESCE(p.team_id,'') || COALESCE(p.copied_from,'') AS BLOB))
        FROM "BridgeQueuePreset" p WHERE p.owner_id = ${userId}
      UNION ALL
      SELECT 'presets', length(CAST(l.id || l.preset_id || l.user_id AS BLOB)) FROM "BridgeQueuePresetLike" l WHERE l.user_id = ${userId}
      UNION ALL
      SELECT 'reports', length(CAST(l.id || l.operator_id || l.action || COALESCE(l.target_type,'') || COALESCE(l.target_id,'') || COALESCE(l.detail,'') AS BLOB))
        FROM "OperationLog" l WHERE l.operator_id = ${userId} AND l.action IN ('bridge_client_report','bridge_binding_edit')
      UNION ALL
      SELECT 'feedback', length(CAST(f.id || COALESCE(f.user_id,'') || f.content || COALESCE(f.image_urls_json,'') || COALESCE(f.page_url,'') || COALESCE(f.pathname,'') || COALESCE(f.user_agent,'') || COALESCE(f.admin_note,'') AS BLOB)) FROM plugin_feedback f
      UNION ALL
      SELECT 'feedback', length(CAST(s.key || s.value_json AS BLOB)) FROM "PlatformSetting" s WHERE s.updated_by = ${userId} AND
        (s.key IN (SELECT 'feedback-source:v1:' || id FROM plugin_feedback) OR
          (substr(s.key,1,length('feedback-submit:v1:' || ${userId} || ':')) = 'feedback-submit:v1:' || ${userId} || ':'
           AND json_extract(CASE WHEN json_valid(s.value_json) THEN s.value_json ELSE '{}' END, '$.result.feedback.id') IN (SELECT id FROM plugin_feedback)))
      UNION ALL
      SELECT 'feedback', length(CAST(n.id || n.type || n.title || COALESCE(n.body,'') || COALESCE(n.metadata_json,'') || COALESCE(n.error_message,'') AS BLOB)) FROM plugin_notifications n
    ) SELECT kind, COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS records, NULL AS reference FROM payloads GROUP BY kind
      UNION ALL SELECT 'reference_url',0,0,url FROM referenced_urls
      UNION ALL SELECT 'reference_id',0,0,asset_id FROM referenced_ids
  `;
  const urls = new Set<string>(), ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.reference !== 'string') continue;
    if (row.kind === 'reference_id') ids.add(row.reference);
    if (row.kind === 'reference_url') {
      urls.add(siteUploadPathFromUrl(row.reference) || row.reference);
    }
  }
  // Only small headers belonging to this user, on demand. Reuse the site's URL
  // normalization on both sides; never fetch the originals or scan the disk.
  const assets = urls.size || ids.size ? await prisma.asset.findMany({ where: { owner_id: userId, file_size: { gt: 0 } },
    select: { id: true, hash: true, original_url: true, file_size: true } }) : [];
  const originals = new Map<string,number>(), parents = new Map<string,string>();
  function root(key: string) {
    if (!parents.has(key)) { parents.set(key,key); originals.set(key,0); }
    let result = key;
    while (parents.get(result) !== result) result = parents.get(result)!;
    while (parents.get(key) !== key) { const next = parents.get(key)!; parents.set(key,result); key = next; }
    return result;
  }
  for (const asset of assets) {
    const canonical = siteUploadPathFromUrl(asset.original_url) || asset.original_url;
    if (!ids.has(asset.id) && !urls.has(canonical)) continue;
    const key = root('url:' + canonical);
    if (asset.hash && /^[a-f0-9]{64}$/.test(asset.hash)) {
      const content = root('hash:' + asset.hash);
      if (content !== key) { parents.set(content,key); originals.set(key,Math.max(originals.get(key) || 0,originals.get(content) || 0)); originals.delete(content); }
    }
    originals.set(key, Math.max(originals.get(key) || 0, asset.file_size));
  }
  rows.push({ kind: 'attachments', bytes: Array.from(originals.values()).reduce((sum,bytes) => sum + bytes,0), records: originals.size, reference: null });
  const safe = (value: bigint | number) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw Error('storage_usage_invalid');
    return result;
  };
  const categories = ['directory','reviews','presets','settings','reports','feedback','attachments'].map(kind => {
    const row = rows.find(value => value.kind === kind);
    return { kind, bytes: row ? safe(row.bytes) : 0, records: row ? safe(row.records) : 0 };
  });
  const totalBytes = categories.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw Error('storage_usage_invalid');
  return { userId, totalBytes, categories, checkedAt: new Date().toISOString(), basis: 'confirmed-content-and-originals' as const };
}
