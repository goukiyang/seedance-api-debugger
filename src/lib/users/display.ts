export interface DisplayUser {
  id?: string | null;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  account_type?: string | null;
}

export function isSyntheticFeishuEmail(email: string | null | undefined) {
  const value = email?.trim().toLowerCase();
  if (!value) return false;
  return value.endsWith('@feishu.local') || value.startsWith('feishu_');
}

export function isTechnicalUsername(username: string | null | undefined) {
  const value = username?.trim().toLowerCase();
  if (!value) return false;
  return value.startsWith('ou_')
    || value.startsWith('ou-')
    || value.startsWith('feishu_')
    || value.startsWith('open_')
    || value.startsWith('union_')
    || value.length > 40;
}

export function displayUserName(user: DisplayUser | null | undefined) {
  if (!user) return '未知用户';

  const name = user.name?.trim();
  if (name && !isTechnicalUsername(name)) return name;

  const email = user.email?.trim();
  if (email && !isSyntheticFeishuEmail(email)) return email;

  const username = user.username?.trim();
  if (username && !isTechnicalUsername(username)) return username;

  const id = user.id?.trim();
  return id ? `用户 ${id.slice(0, 6)}` : '未知用户';
}

export function displayUserSubtitle(user: DisplayUser | null | undefined) {
  if (!user) return '';

  const email = user.email?.trim();
  if (email && !isSyntheticFeishuEmail(email) && email !== displayUserName(user)) return email;

  const username = user.username?.trim();
  if (username && !isTechnicalUsername(username) && username !== displayUserName(user)) return username;

  if (user.account_type === 'external') return '外部用户';
  if (user.account_type === 'internal') return '内部用户';

  return '';
}

export function displayUserInitials(user: DisplayUser | null | undefined) {
  const label = displayUserName(user);
  const localPart = label.includes('@') ? label.split('@')[0] : label;
  const segments = localPart
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (segments.length >= 2) {
    return `${segments[0][0] || ''}${segments[1][0] || ''}`.toUpperCase();
  }

  return Array.from(segments[0] || localPart || 'U').slice(0, 2).join('').toUpperCase();
}

const USER_COLOR_PALETTE = [
  'oklch(42% 0.08 252)',
  'oklch(43% 0.08 302)',
  'oklch(42% 0.07 165)',
  'oklch(45% 0.08 54)',
  'oklch(41% 0.06 224)',
  'oklch(42% 0.07 350)',
];

export function userAvatarColor(user: DisplayUser | null | undefined) {
  const source = `${user?.id || ''}${user?.email || ''}${user?.username || ''}${user?.name || ''}`;
  const hash = Array.from(source || 'user').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length];
}
