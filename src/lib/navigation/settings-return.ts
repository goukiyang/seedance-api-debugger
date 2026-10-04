'use client';

let current = '';
let previous = '';

export function rememberSettingsOrigin() {
  const next = window.location.pathname + window.location.search + window.location.hash;
  if (next === current) return;
  previous = current;
  current = next;
}

export function settingsReturnTarget(fallback: string) {
  const here = new URL(window.location.href);
  const requested = here.searchParams.get('return_to');
  for (const candidate of [requested, previous, document.referrer]) {
    if (!candidate || /[\\\u0000-\u001f\u007f]/.test(candidate)) continue;
    try {
      const target = new URL(candidate, here.origin);
      if (target.origin !== here.origin || target.pathname === here.pathname
        || !/^\/(admin|generate|template-studio|image-studio|projects|assets|tasks)(\/|$)/.test(target.pathname)) continue;
      return target.pathname + target.search + target.hash;
    } catch { /* Invalid or external origins fall back to the owning page. */ }
  }
  return fallback;
}
