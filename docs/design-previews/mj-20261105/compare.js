(() => {
  const frame = document.getElementById('preview');
  const stage = document.getElementById('stage');
  const status = document.getElementById('status');
  const original = document.querySelector('.site-link');
  const loginGate = document.getElementById('login-gate');
  const loginLink = document.getElementById('login-link');
  const variants = Array.from(document.querySelectorAll('[data-variant]'));
  const viewports = Array.from(document.querySelectorAll('button[data-viewport]'));
  const query = new URL(location.href).searchParams;
  const pages = {
    a: { href: '/works', path: '/works', label: 'A · 作品广场' },
    b: { href: '/template-studio?type=image', path: '/template-studio', label: 'B · 图片模板工作台' },
    c: { href: '/generate', path: '/generate', label: 'C · 视频生成' },
    d: { href: '/template-studio?type=image', path: '/template-studio', label: 'D · 图片生成' },
  };
  let variant = Object.hasOwn(pages, query.get('variant')) ? query.get('variant') : 'a';
  let viewport = query.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
  let navigationVersion = 0;
  let targetVersion = 0;
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
    variants.find(button => button.dataset.variant === variant)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    for (const button of viewports) button.setAttribute('aria-pressed', String(button.dataset.viewport === viewport));
    stage.dataset.viewport = viewport;
    original.href = pages[variant].href;
    frame.title = `${pages[variant].label}，使用当前账号与真实内容`;
    const url = new URL(location.href);
    url.searchParams.set('variant', variant);
    if (viewport === 'mobile') url.searchParams.set('viewport', viewport); else url.searchParams.delete('viewport');
    history.replaceState(null, '', url);
    const loginUrl = new URL('/login', location.href);
    loginUrl.searchParams.set('next', url.pathname + url.search + url.hash);
    loginLink.href = loginUrl.pathname + loginUrl.search;
  }

  function requireLogin() {
    clearTimeout(reconnectTimer);
    frame.hidden = true;
    loginGate.hidden = false;
    status.textContent = '请先在整页完成原站登录，登录后会返回当前样板。';
  }

  function openPage(name) {
    clearTimeout(reconnectTimer);
    navigationVersion++;
    const target = ++targetVersion;
    reconnectAttempts = 0;
    variant = name;
    sync();
    loginGate.hidden = true;
    frame.hidden = false;
    frame.classList.remove('is-ready');
    status.textContent = `正在载入${pages[variant].label}。页面操作在原站生效。`;
    if (variant === 'd') {
      frame.hidden = true;
      status.textContent = '正在读取当前账号的图片生成工作区…';
      void openImageWorkspace(target);
      return;
    }
    frame.src = pages[variant].href;
  }

  async function openImageWorkspace(target) {
    try {
      const response = await fetch('/api/auth/me', { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('session-unavailable');
      const data = await response.json();
      if (target !== targetVersion) return;
      if (data.user === null) { requireLogin(); return; }
      if (typeof data.user?.id !== 'string' || !data.user.id) throw new Error('session-unavailable');
      pages.d.href = `/template-studio?type=image&moduleId=${encodeURIComponent(`default-${data.user.id}`)}`;
      sync();
      frame.hidden = false;
      status.textContent = '正在载入本人图片生成工作区。页面操作在原站生效。';
      frame.src = pages.d.href;
    } catch {
      if (target !== targetVersion) return;
      status.textContent = '当前账号信息暂未读取，请点击“重新载入”。原工作区与输入保留。';
    }
  }

  frame.addEventListener('load', () => {
    if (variant === 'd' && frame.hidden && loginGate.hidden) return;
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
        requireLogin();
        return;
      }
      if (current.pathname !== pages[variant].path) {
        loginGate.hidden = true;
        frame.hidden = false;
        status.textContent = '当前为原站其他页面；原访问权限保持，点击上方页面选项可返回样板。';
        frame.classList.add('is-ready');
        return;
      }
    } catch {
      requireLogin();
      return;
    }
    loginGate.hidden = true;
    frame.hidden = false;
    if (variant === 'c') doc.querySelector('.composer-page')?.classList.add('mj-generation-page');
    if (variant === 'd') doc.querySelector('.shell-root')?.classList.add('mj-image-generation-page');
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    const versionTag = { a: 'r02', b: 'r02', c: 'r05-generation', d: 'r07-image' };
    link.href = new URL(`${variant}.css?v=${versionTag[variant]}`, location.href).href;
    const withUx = variant === 'c' || variant === 'd';
    let pendingAssets = withUx ? 3 : 1;
    const assetReady = () => {
      if (version !== navigationVersion || frame.contentDocument !== doc) return;
      if (--pendingAssets) return;
      status.textContent = `${pages[variant].label} · 真实内容，页面操作在原站生效。`;
      frame.classList.add('is-ready');
    };
    const assetError = () => {
      if (version !== navigationVersion || frame.contentDocument !== doc) return;
      status.textContent = '预览样式或控件未能载入，请重新载入。';
      frame.classList.add('is-ready');
    };
    link.onload = assetReady;
    link.onerror = assetError;
    doc.head.appendChild(link);
    if (withUx) {
      const uxStyle = doc.createElement('link');
      uxStyle.rel = 'stylesheet';
      uxStyle.href = new URL('ux-r07.css', location.href).href;
      uxStyle.onload = assetReady;
      uxStyle.onerror = assetError;
      const uxScript = doc.createElement('script');
      uxScript.src = new URL('ux-r06.js', location.href).href;
      uxScript.onload = assetReady;
      uxScript.onerror = assetError;
      doc.head.append(uxStyle, uxScript);
    }
  });
  for (const button of variants) button.addEventListener('click', () => {
    if (button.dataset.variant !== variant) openPage(button.dataset.variant);
  });
  for (const button of viewports) button.addEventListener('click', () => {
    viewport = button.dataset.viewport;
    sync();
  });
  document.getElementById('login-reload').addEventListener('click', () => openPage(variant));
  document.getElementById('reload').addEventListener('click', () => openPage(variant));
  openPage(variant);
})();
