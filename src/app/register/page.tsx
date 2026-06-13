'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type RegisterUser = {
  role?: string;
};

function defaultLanding(user?: RegisterUser | null) {
  return '/generate';
}

function safeLandingPath(value: string | null | undefined, fallback: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

function currentOriginLandingUrl(value: string | null | undefined, fallback: string) {
  return new URL(safeLandingPath(value, fallback), window.location.origin).toString();
}

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [debugCode, setDebugCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [feishuLoading, setFeishuLoading] = useState(false);
  const [emailRegisterOpen, setEmailRegisterOpen] = useState(false);

  const normalizedEmail = () => email.trim().toLowerCase();

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && !safeLandingPath(next, '')) {
      window.history.replaceState(null, '', '/register');
    }

    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.user) router.replace(safeLandingPath(next, defaultLanding(data.user)));
      })
      .catch(() => {});
  }, [router]);

  const validateBaseFields = () => {
    const nextEmail = normalizedEmail();
    if (!nextEmail) {
      setError('请输入邮箱');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setError('请输入有效邮箱');
      return false;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位');
      return false;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return false;
    }
    return true;
  };

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setDebugCode('');
    if (!validateBaseFields()) return;

    const registerEmail = normalizedEmail();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email: registerEmail, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '注册失败');
        return;
      }
      if (data.user) {
        const next = new URLSearchParams(window.location.search).get('next');
        router.replace(safeLandingPath(next, defaultLanding(data.user)));
        return;
      }
      setCodeSent(true);
      setMessage(`验证码已发送至 ${registerEmail}，请查收邮箱`);
      if (data.debug_code) setDebugCode(data.debug_code);
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  const verifyAndRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!code.trim()) {
      setError('请输入邮箱验证码');
      return;
    }

    setLoading(true);
    const registerEmail = normalizedEmail();
    try {
      const res = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: registerEmail, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '注册失败');
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(safeLandingPath(next, defaultLanding(data.user)));
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  const handleFeishuLogin = async () => {
    setError('');
    setMessage('');
    setDebugCode('');
    setFeishuLoading(true);

    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const params = new URLSearchParams();
      const safeNext = safeLandingPath(next, '');
      if (safeNext) params.set('next', safeNext);

      const res = await fetch(`/api/auth/feishu/authorize-url${params.size ? `?${params.toString()}` : ''}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'disabled' || data.code === 'not_configured') {
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
          window.location.assign(currentOriginLandingUrl(safeNext, defaultLanding(cliData.user)));
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

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: 6,
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f0f13',
      padding: 24,
    }}>
      <div style={{
        width: 400,
        maxWidth: '100%',
        padding: '40px 32px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            fontSize: 24,
            fontWeight: 700,
            color: '#fff',
            marginBottom: 8,
            letterSpacing: 2,
          }}>Seedance 2.0</div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)' }}>内部平台</div>
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
          {feishuLoading ? '正在前往飞书...' : '使用飞书登录 / 注册'}
        </button>

        <button
          type="button"
          aria-expanded={emailRegisterOpen}
          onClick={() => setEmailRegisterOpen((value) => !value)}
          disabled={loading || feishuLoading || codeSent}
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
            cursor: loading || feishuLoading || codeSent ? 'not-allowed' : 'pointer',
          }}
        >
          {emailRegisterOpen ? '收起邮箱注册' : '使用邮箱注册'}
        </button>

        {(error || message || debugCode) && (
          <div style={{
            padding: '10px 12px',
            background: error ? 'rgba(255,80,80,0.1)' : 'rgba(74,222,128,0.1)',
            border: error ? '1px solid rgba(255,80,80,0.3)' : '1px solid rgba(74,222,128,0.25)',
            borderRadius: 8,
            color: error ? '#ff6060' : '#86efac',
            fontSize: 13,
            marginTop: 16,
            marginBottom: emailRegisterOpen ? 16 : 0,
          }}>
            {error || message}
            {debugCode && (
              <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.75)' }}>
                开发环境验证码：{debugCode}
              </div>
            )}
          </div>
        )}

        {emailRegisterOpen && (
          <form onSubmit={codeSent ? verifyAndRegister : requestCode} noValidate style={{ marginTop: 18 }}>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>用户名</label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={codeSent || loading}
                style={inputStyle}
                placeholder="不填则使用邮箱前缀"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value.trim().toLowerCase())}
                disabled={codeSent || loading}
                style={inputStyle}
                placeholder="name@example.com"
                autoComplete="email"
              />
            </div>

            {!codeSent && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>密码</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    style={inputStyle}
                    placeholder="至少 8 位"
                  />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>确认密码</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    style={inputStyle}
                    placeholder="再次输入密码"
                  />
                </div>
              </>
            )}

            {codeSent && (
              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>邮箱验证码</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  style={{ ...inputStyle, letterSpacing: 4 }}
                  placeholder="6 位验证码"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || feishuLoading}
              style={{
                width: '100%',
                padding: '12px',
                background: loading || feishuLoading ? 'rgba(99,102,241,0.5)' : '#6366f1',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: loading || feishuLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? '处理中...' : codeSent ? '验证并注册' : '注册并进入'}
            </button>
          </form>
        )}

        {codeSent && (
          <button
            type="button"
            onClick={() => {
              setCodeSent(false);
              setCode('');
              setError('');
              setMessage('');
              setDebugCode('');
            }}
            disabled={loading}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8,
              color: 'rgba(255,255,255,0.72)',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            修改邮箱或重发验证码
          </button>
        )}

        <div style={{
          marginTop: 24,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(255,255,255,0.35)',
        }}>
          已有账号？ <Link href="/login" style={{ color: '#a5b4fc', textDecoration: 'none' }}>去登录</Link>
        </div>
      </div>
    </div>
  );
}
