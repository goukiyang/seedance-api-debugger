'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 如果已登录直接跳转
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => {
        if (d.user) {
          router.replace(d.user.role === 'admin' ? '/admin/users' : '/generate');
        }
      })
      .catch(() => {});
  }, [router]);

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

      // 登录成功，跳转
      if (data.user.role === 'admin') {
        router.replace('/admin/users');
      } else {
        router.replace('/generate');
      }
    } catch {
      setError('网络错误，请重试');
      setLoading(false);
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

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block',
              fontSize: 13,
              color: 'rgba(255,255,255,0.6)',
              marginBottom: 6,
            }}>账号 / 邮箱</label>
            <input
              type="text"
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              required
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
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
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

          {error && (
            <div style={{
              padding: '10px 12px',
              background: 'rgba(255,80,80,0.1)',
              border: '1px solid rgba(255,80,80,0.3)',
              borderRadius: 8,
              color: '#ff6060',
              fontSize: 13,
              marginBottom: 16,
            }}>{error}</div>
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
            {loading ? '登录中...' : '登录'}
          </button>
        </form>

        <div style={{
          marginTop: 24,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(255,255,255,0.3)',
        }}>
          遇到问题？联系管理员
        </div>
      </div>
    </div>
  );
}
