export const TEMPLATE_MARK_WRITES_ENABLED = true;

/** One private template mark, reading both historical flags without migrating rows. */
export function isTemplateContentKey(key: string) {
  return /^(image_template|image_module|video_template|video_draft|legacy_template):/.test(key);
}

export function templateMarkData(current: { liked: boolean; liked_at: Date | null; favorited_at: Date | null } | null, active: boolean, now: Date) {
  return active
    ? { favorited: true, favorited_at: current?.favorited_at || current?.liked_at || now }
    : { liked: false, favorited: false, liked_at: null, favorited_at: null };
}
