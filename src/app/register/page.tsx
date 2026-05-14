'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { COMPANY_EMAIL_DOMAIN } from '@/lib/auth/registration/config';

type RegisterUser = {
  role?: string;
};

function defaultLanding(user?: RegisterUser | null) {
  return user?.role === 'admin' ? '/dashboard' : '/generate';
}

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [emailPrefix, setEmailPrefix] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [debugCode, setDebugCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const normalizeEmailPrefix = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized.endsWith(COMPANY_EMAIL_DOMAIN)) {
      return normalized.slice(0, -COMPANY_EMAIL_DOMAIN.length);
    }
    return normalized.replace(/\s/g, '');
  };

  const fullEmail = () => `${normalizeEmailPrefix(emailPrefix)}${COMPANY_EMAIL_DOMAIN}`;

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.user) router.replace(next || defaultLanding(data.user));
      })
      .catch(() => {});
  }, [router]);

  const validateBaseFields = () => {
    const normalizedPrefix = normalizeEmailPrefix(emailPrefix);
    if (!normalizedPrefix) {
      setError('请输入公司邮箱前缀');
      return false;
    }
    if (normalizedPrefix.includes('@') || !/^[a-z0-9._-]+$/.test(normalizedPrefix)) {
      setError('邮箱前缀只能包含字母、数字、点、下划线或短横线');
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

    const email = fullEmail();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '注册失败');
        return;
      }
      if (data.user) {
        const next = new URLSearchParams(window.location.search).get('next');
        router.replace(next || defaultLanding(data.user));
        return;
      }
      setCodeSent(true);
      setMessage(`验证码已发送至 ${email}，请查收公司邮箱`);
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
    const email = fullEmail();
    try {
      const res = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '注册失败');
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(next || defaultLanding(data.user));
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
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
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)' }}>公司邮箱注册</div>
        </div>

        <form onSubmit={codeSent ? verifyAndRegister : requestCode} noValidate>
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
            <label style={labelStyle}>公司邮箱</label>
            <div style={{
              display: 'flex',
              alignItems: 'stretch',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              overflow: 'hidden',
            }}>
              <input
                type="text"
                value={emailPrefix}
                onChange={(event) => setEmailPrefix(normalizeEmailPrefix(event.target.value))}
                disabled={codeSent || loading}
                style={{
                  ...inputStyle,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 0,
                }}
                placeholder="name"
                autoComplete="username"
              />
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 12px',
                color: 'rgba(255,255,255,0.62)',
                borderLeft: '1px solid rgba(255,255,255,0.1)',
                whiteSpace: 'nowrap',
                fontSize: 14,
              }}>
                {COMPANY_EMAIL_DOMAIN}
              </span>
            </div>
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

          {(error || message || debugCode) && (
            <div style={{
              padding: '10px 12px',
              background: error ? 'rgba(255,80,80,0.1)' : 'rgba(74,222,128,0.1)',
              border: error ? '1px solid rgba(255,80,80,0.3)' : '1px solid rgba(74,222,128,0.25)',
              borderRadius: 8,
              color: error ? '#ff6060' : '#86efac',
              fontSize: 13,
              marginBottom: 16,
            }}>
              {error || message}
              {debugCode && (
                <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.75)' }}>
                  开发环境验证码：{debugCode}
                </div>
              )}
            </div>
          )}

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
              transition: 'background 0.2s',
            }}
          >
            {loading ? '处理中...' : codeSent ? '验证并注册' : '注册并进入'}
          </button>
        </form>

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
            修改邮箱或重新发送
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
