'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { defaultLandingForUser, safeLandingForUser } from '@/lib/access/external-user';

type CallbackUser = {
  role?: string;
  account_type?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: '你已取消飞书授权',
  missing_code: '飞书回调缺少授权码',
  invalid_state: '飞书登录状态已失效，请重新发起登录',
  disabled: '飞书登录暂未启用',
  not_configured: '飞书登录配置不完整',
  cli_login_disabled: '飞书 CLI 登录未启用',
  cli_login_failed: '飞书 CLI 登录失败，请确认本机 lark-cli 已登录',
  cli_open_id_missing: '飞书 CLI 未返回用户身份，请重新登录 lark-cli',
  not_provisioned: '飞书账号未开通，请联系管理员',
  identity_conflict: '飞书账号匹配到冲突的系统账号，请联系管理员',
  tenant_not_allowed: '当前飞书企业未被允许登录',
  department_not_allowed: '当前飞书部门未被允许登录',
  department_check_unavailable: '暂时无法校验飞书部门权限',
  user_disabled: '账号已被禁用',
  user_expired: '账号已过期',
  user_not_active: '账号暂不可登录',
  server_error: '飞书登录失败，请重试',
};

function defaultLanding(user?: CallbackUser | null) {
  return defaultLandingForUser(user);
}

function safeLandingPath(value: string | null | undefined, fallback: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

export default function FeishuCallbackPage({
  searchParams,
}: {
  searchParams?: { error?: string; next?: string; status?: string };
}) {
  const [message, setMessage] = useState('正在确认飞书登录状态...');
  const errorMessage = useMemo(() => {
    if (!searchParams?.error) return '';
    return ERROR_MESSAGES[searchParams.error] || '飞书登录失败，请重试';
  }, [searchParams?.error]);

  useEffect(() => {
    if (errorMessage) return;

    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.user) {
          setMessage('登录态确认失败，请重新登录');
          return;
        }
        const next = safeLandingForUser(safeLandingPath(searchParams?.next, ''), data.user);
        window.location.replace(new URL(next, window.location.origin).toString());
      })
      .catch(() => {
        if (!cancelled) setMessage('网络异常，请重新登录');
      });

    return () => {
      cancelled = true;
    };
  }, [errorMessage, searchParams?.next]);

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
        width: 360,
        padding: '34px 30px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        textAlign: 'center',
      }}>
        <div style={{
          fontSize: 22,
          fontWeight: 700,
          color: '#f7f7fb',
          marginBottom: 10,
        }}>飞书登录</div>
        <div style={{
          fontSize: 14,
          lineHeight: 1.7,
          color: errorMessage ? '#ff8080' : 'rgba(255,255,255,0.55)',
          marginBottom: errorMessage ? 24 : 0,
        }}>
          {errorMessage || message}
        </div>
        {errorMessage && (
          <Link
            href="/login"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: 42,
              borderRadius: 8,
              background: '#6366f1',
              color: '#f7f7fb',
              fontSize: 14,
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            返回登录页
          </Link>
        )}
      </div>
    </div>
  );
}
