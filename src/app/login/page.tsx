'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { defaultLandingForUser, safeLandingForUser } from '@/lib/access/external-user';

type LoginUser = {
  role?: string;
  account_type?: string;
};

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  invalid: '账号或密码错误',
  missing: '账号和密码不能为空',
};

function defaultLanding(user?: LoginUser | null) {
  return defaultLandingForUser(user);
}

function safeLandingPath(value: string | null | undefined, fallback: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

function currentOriginLandingUrl(value: string | null | undefined, fallback: string) {
  return new URL(safeLandingPath(value, fallback), window.location.origin).toString();
}

function feishuAuthorizePath(next: string | null) {
  const params = new URLSearchParams();
  const safeNext = safeLandingPath(next, '');
  if (safeNext) params.set('next', safeNext);
  return `/api/auth/feishu/authorize${params.size ? `?${params.toString()}` : ''}`;
}

function shouldUseLocalFeishuFallback() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { error?: string; next?: string };
}) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(searchParams?.error ? LOGIN_ERROR_MESSAGES[searchParams.error] || '登录失败，请重试' : '');
  const [loading, setLoading] = useState(false);
  const [feishuLoading, setFeishuLoading] = useState(false);
  const [passwordLoginOpen, setPasswordLoginOpen] = useState(Boolean(searchParams?.error));

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && !safeLandingPath(next, '')) {
      window.history.replaceState(null, '', '/login');
    }

    // 如果已登录直接跳转
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => {
        if (d.user) {
          window.location.replace(currentOriginLandingUrl(safeLandingForUser(next, d.user), defaultLanding(d.user)));
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || '登录失败');
        setLoading(false);
        return;
      }

      const next = new URLSearchParams(window.location.search).get('next');
      window.location.assign(currentOriginLandingUrl(safeLandingForUser(next, data.user), defaultLanding(data.user)));
    } catch {
      setError('网络错误，请重试');
      setLoading(false);
    }
  };

  const handleFeishuLogin = async () => {
    setError('');
    setFeishuLoading(true);

    const next = new URLSearchParams(window.location.search).get('next');
    if (!shouldUseLocalFeishuFallback()) {
      window.location.assign(feishuAuthorizePath(next));
      return;
    }

    try {
      const params = new URLSearchParams();
      const safeNext = safeLandingPath(next, '');
      if (safeNext) params.set('next', safeNext);

      const res = await fetch(`/api/auth/feishu/authorize-url${params.size ? `?${params.toString()}` : ''}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'disabled' || data.code === 'not_configured') {
          if (!data.cli_login_available) {
            setError(data.error || '飞书登录暂不可用');
            setFeishuLoading(false);
            return;
          }

          const cliRes = await fetch('/api/auth/feishu/cli-login', {
            method: 'POST',
            cache: 'no-store',
          });
          const cliData = await cliRes.json();
          if (!cliRes.ok) {
            setError(cliData.error || data.error || '飞书登录暂不可用');
            setFeishuLoading(false);
            return;
          }
          window.location.assign(currentOriginLandingUrl(safeLandingForUser(safeNext, cliData.user), defaultLanding(cliData.user)));
          return;
        }

        setError(data.error || '飞书登录暂不可用');
        setFeishuLoading(false);
        return;
      }
      window.location.assign(data.authorize_url);
    } catch {
      setError('飞书登录初始化失败，请重试');
      setFeishuLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f0f13',
    }}>
      <div style={{
        width: 360,
        padding: '40px 32px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            fontSize: 24,
            fontWeight: 700,
            color: '#fff',
            marginBottom: 8,
            letterSpacing: 2,
          }}>Seedance 2.0</div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>内部平台</div>
        </div>

        <button
          type="button"
          onClick={handleFeishuLogin}
          disabled={loading || feishuLoading}
          style={{
            width: '100%',
            padding: '12px',
            background: feishuLoading ? 'rgba(29, 78, 216, 0.52)' : '#1d4ed8',
            border: 'none',
            borderRadius: 8,
            color: '#f8fafc',
            fontSize: 14,
            fontWeight: 700,
            cursor: loading || feishuLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {feishuLoading ? '正在前往飞书...' : '使用飞书登录'}
        </button>

        <button
          type="button"
          aria-expanded={passwordLoginOpen}
          onClick={() => setPasswordLoginOpen((value) => !value)}
          disabled={loading || feishuLoading}
          style={{
            width: '100%',
            marginTop: 14,
            padding: '11px 12px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            color: 'rgba(255,255,255,0.76)',
            fontSize: 14,
            fontWeight: 600,
            cursor: loading || feishuLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {passwordLoginOpen ? '收起账号密码登录' : '使用账号密码登录'}
        </button>

        {error && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(255,80,80,0.1)',
            border: '1px solid rgba(255,80,80,0.3)',
            borderRadius: 8,
            color: '#ff6060',
            fontSize: 13,
            marginTop: 16,
            marginBottom: passwordLoginOpen ? 16 : 0,
          }}>{error}</div>
        )}

        {passwordLoginOpen && (
          <form action="/api/auth/login" method="post" onSubmit={handleSubmit} style={{ marginTop: 18 }}>
            <input type="hidden" name="next" value={safeLandingPath(searchParams?.next, '')} />
            <div style={{ marginBottom: 16 }}>
              <label style={{
                display: 'block',
                fontSize: 13,
                color: 'rgba(255,255,255,0.6)',
                marginBottom: 6,
              }}>账号 / 邮箱</label>
              <input
                type="text"
                name="identifier"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                autoComplete="username"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: '#fff',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                placeholder="请输入账号或邮箱"
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{
                display: 'block',
                fontSize: 13,
                color: 'rgba(255,255,255,0.6)',
                marginBottom: 6,
              }}>密码</label>
              <input
                type="password"
                name="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: '#fff',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                placeholder="请输入密码"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                background: loading ? 'rgba(99,102,241,0.5)' : '#6366f1',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        )}

        <div style={{
          marginTop: 24,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(255,255,255,0.3)',
        }}>
          没有账号？ <Link href="/register" style={{ color: '#a5b4fc', textDecoration: 'none' }}>邮箱注册</Link>
          <div style={{ marginTop: 8 }}>遇到问题？联系管理员</div>
        </div>
      </div>
    </div>
  );
}
