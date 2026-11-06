(() => {
  const frame = document.getElementById('preview');
  const stage = document.getElementById('stage');
  const status = document.getElementById('status');
  const original = document.querySelector('.site-link');
  const variants = Array.from(document.querySelectorAll('[data-variant]'));
  const viewports = Array.from(document.querySelectorAll('button[data-viewport]'));
  const query = new URL(location.href).searchParams;
  const pages = {
    a: { href: '/works', path: '/works', label: 'A · 作品广场' },
    b: { href: '/template-studio?type=image', path: '/template-studio', label: 'B · 图片模板工作台' },
  };
  let variant = query.get('variant') === 'b' ? 'b' : 'a';
  let viewport = query.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
  let navigationVersion = 0;
  let reconnectAttempts = 0;
  let reconnectTimer;
  const reconnectDelays = [2500, 5000, 10000];

  function reconnect(version, failedDocument, failedUrl) {
    if (reconnectAttempts >= reconnectDelays.length) {
      status.textContent = '原站暂时不可用，请稍后点击“重新载入”。';
      return;
    }
    status.textContent = '原站暂时不可用，正在重新连接…';
    const delay = reconnectDelays[reconnectAttempts++];
    reconnectTimer = setTimeout(async () => {
      if (version !== navigationVersion || frame.contentDocument !== failedDocument) return;
      let available = false;
      try {
        const response = await fetch('/api/release', { method: 'GET', cache: 'no-store' });
        available = response.ok;
      } catch { /* A restarting upstream may also close the readiness connection. */ }
      if (version !== navigationVersion || frame.contentDocument !== failedDocument) return;
      if (available) {
        status.textContent = '原站已恢复，正在重新载入页面…';
        frame.classList.remove('is-ready');
        // Reload only the failed document with GET; never replay a business action.
        frame.src = failedUrl;
      } else {
        reconnect(version, failedDocument, failedUrl);
      }
    }, delay);
  }

  function sync() {
    for (const button of variants) button.setAttribute('aria-pressed', String(button.dataset.variant === variant));
    for (const button of viewports) button.setAttribute('aria-pressed', String(button.dataset.viewport === viewport));
    stage.dataset.viewport = viewport;
    original.href = pages[variant].href;
    frame.title = `${pages[variant].label}，使用当前账号与真实内容`;
    const url = new URL(location.href);
    url.searchParams.set('variant', variant);
    if (viewport === 'mobile') url.searchParams.set('viewport', viewport); else url.searchParams.delete('viewport');
    history.replaceState(null, '', url);
  }

  function openPage(name) {
    clearTimeout(reconnectTimer);
    navigationVersion++;
    reconnectAttempts = 0;
    variant = name;
    sync();
    frame.classList.remove('is-ready');
    status.textContent = `正在载入${pages[variant].label}。页面操作在原站生效。`;
    frame.src = pages[variant].href;
  }

  frame.addEventListener('load', () => {
    clearTimeout(reconnectTimer);
    const version = ++navigationVersion;
    let doc;
    try {
      doc = frame.contentDocument;
      const current = frame.contentWindow.location;
      if (!doc?.head || current.origin !== location.origin) throw new Error('other-origin');
      const heading = doc.querySelector('h1')?.textContent?.trim() || '';
      const gatewayError = /\b50[234]\b/.test(doc.title || '') || /^50[234](?:\s|:)/.test(heading);
      const applicationShell = doc.querySelector('.shell-root, [class*="Works_page__"], [aria-label="模板工作台"]');
      if (gatewayError && !applicationShell && current.pathname === pages[variant].path) {
        frame.classList.add('is-ready');
        reconnect(version, doc, current.href);
        return;
      }
      reconnectAttempts = 0;
      if (current.pathname === '/login' || current.pathname === '/register') {
        status.textContent = '请在“打开原站”完成登录，再回这里重新载入。';
        frame.classList.add('is-ready');
        return;
      }
      if (current.pathname !== pages[variant].path) {
        status.textContent = '当前为原站其他页面；原访问权限保持，点击A/B可返回样板。';
        frame.classList.add('is-ready');
        return;
      }
    } catch {
      status.textContent = '请在原站完成登录，再重新载入。';
      frame.classList.add('is-ready');
      return;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`${variant}.css?v=r02`, location.href).href;
    link.onload = () => {
      if (version !== navigationVersion || frame.contentDocument !== doc) return;
      status.textContent = `${pages[variant].label} · 真实内容，页面操作在原站生效。`;
      frame.classList.add('is-ready');
    };
    link.onerror = () => {
      if (version !== navigationVersion || frame.contentDocument !== doc) return;
      status.textContent = '样式未能载入，请重新载入。';
      frame.classList.add('is-ready');
    };
    doc.head.appendChild(link);
  });
  for (const button of variants) button.addEventListener('click', () => {
    if (button.dataset.variant !== variant) openPage(button.dataset.variant);
  });
  for (const button of viewports) button.addEventListener('click', () => {
    viewport = button.dataset.viewport;
    sync();
  });
  document.getElementById('reload').addEventListener('click', () => openPage(variant));
  openPage(variant);
})();
