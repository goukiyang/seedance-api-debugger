/* Presentation-only adapter for the isolated branch preview. Original controls
   keep their handlers; no business requests, storage writes or node moves. */
(() => {
  const scope = '.mj-generation-page, .mj-image-generation-page';
  let scheduled = 0;
  let nextNotice = 0;
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const mark = (node, key, enabled) => {
    if (enabled && !node.hasAttribute(key)) node.setAttribute(key, '');
    else if (!enabled && node.hasAttribute(key)) node.removeAttribute(key);
  };

  function disclosure(parent, key, before, label) {
    let button = parent.querySelector(`:scope > button[data-mj-disclosure="${key}"]`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.mjDisclosure = key;
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(open));
        mark(parent, `data-mj-${key}-open`, open);
        schedule();
      });
      parent.insertBefore(button, before);
    }
    setText(button, label);
    return button;
  }

  function refresh() {
    scheduled = 0;
    if (!document.querySelector(scope)) return;

    for (const sidebar of document.querySelectorAll('[class*="ResourceLibraryPicker_sidebar__"]')) {
      const folders = Array.from(sidebar.querySelectorAll(':scope > button[title="分享的图片"]'));
      const grouped = folders.length > 1;
      for (const folder of folders) mark(folder, 'data-mj-share-folder', grouped);
      const existing = sidebar.querySelector('[data-mj-disclosure="shares"]');
      if (grouped) {
        disclosure(sidebar, 'shares', folders[0], `分享的图片 · ${folders.length} 个图集`);
      } else if (existing) existing.remove();
    }

    for (const sources of document.querySelectorAll('[class*="ResourceLibraryPicker_sourceSegments__"]')) {
      const buttons = Array.from(sources.querySelectorAll(':scope > button:not([data-mj-disclosure])'));
      const common = ['全部来源', '上传的', '全部生成', '模板生图', '随机人物'];
      const extra = buttons.filter(button => !common.includes(button.textContent.trim()));
      for (const button of buttons) mark(button, 'data-mj-secondary-source', extra.includes(button));
      if (extra.length) {
        const expanded = sources.querySelector('[data-mj-disclosure="sources"]')?.getAttribute('aria-expanded') === 'true';
        disclosure(sources, 'sources', null, expanded ? '收起来源' : '更多来源');
      }
    }

    for (const name of document.querySelectorAll('[class*="ResourceLibraryPicker_meta__"] > strong')) {
      const machine = /^(?:image(?:-rate)?|asset|generated)[-_][\da-f-]{12,}/i.test(name.textContent.trim());
      mark(name, 'data-mj-machine-name', machine);
    }
    for (const source of document.querySelectorAll('[class*="ResourceLibraryPicker_meta__"] > small')) {
      mark(source, 'data-mj-generic-source', ['其他生成', '其他素材'].includes(source.textContent.trim()));
    }
    for (const notice of document.querySelectorAll('[class*="ResourceLibraryPicker_main__"] > [class*="ResourceLibraryPicker_notice__"]')) {
      const text = notice.textContent.trim();
      mark(notice, 'data-mj-redundant', /^\d+ 个素材暂不能用于此处，原因显示在对应素材下方/.test(text));
      const history = text.startsWith('上次移出：');
      mark(notice, 'data-mj-history', history);
      if (history && notice.title !== text) notice.title = text;
    }

    for (const setting of document.querySelectorAll('[class*="video-feishu_setting__"]')) {
      const notice = setting.querySelector(':scope > div[class*="video-feishu_notice__"]');
      const existing = setting.querySelector('[data-mj-disclosure="feishu"]');
      if (!notice) {
        existing?.remove();
        mark(setting, 'data-mj-feishu-open', false);
        continue;
      }
      mark(notice, 'data-mj-feishu-notice', true);
      if (!notice.id) notice.id = `mj-feishu-notice-${++nextNotice}`;
      const toggle = disclosure(setting, 'feishu', notice, '本次不发飞书 · 原因');
      if (toggle.getAttribute('aria-controls') !== notice.id) toggle.setAttribute('aria-controls', notice.id);
    }
  }

  function schedule() {
    if (!scheduled) scheduled = requestAnimationFrame(refresh);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
  document.addEventListener('pointerdown', event => {
    for (const setting of document.querySelectorAll('[data-mj-feishu-open]')) {
      if (setting.contains(event.target)) continue;
      setting.removeAttribute('data-mj-feishu-open');
      setting.querySelector('[data-mj-disclosure="feishu"]')?.setAttribute('aria-expanded', 'false');
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const setting = document.querySelector('[data-mj-feishu-open]');
    if (!setting) return;
    setting.removeAttribute('data-mj-feishu-open');
    const button = setting.querySelector('[data-mj-disclosure="feishu"]');
    button?.setAttribute('aria-expanded', 'false');
    button?.focus();
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener('pagehide', () => { observer.disconnect(); cancelAnimationFrame(scheduled); }, { once: true });
  refresh();
})();
