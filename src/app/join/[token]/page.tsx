'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function JoinProjectPage() {
  const params = useParams<{ token: string }>();
  const [joining, setJoining] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const joinProject = async () => {
    setJoining(true);
    setError('');
    try {
      const res = await fetch(`/api/project-invites/${params.token}/join`, { method: 'POST' });
      const data = await res.json();
      if (res.status === 401) {
        setError('请先登录后再加入项目');
        return;
      }
      if (!res.ok) {
        setError(data.error || data.message || '加入项目失败');
        return;
      }
      setProjectId(data.project_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入项目失败');
    } finally {
      setJoining(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 520 }}>
        <h1 className="page-title">加入项目</h1>
        <p className="page-description">登录后可以通过邀请链接加入项目。禁用、过期或账号类型不匹配的账号不能加入。</p>

        {projectId ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <p className="text-green">已加入项目。</p>
            <Link href={`/projects/${projectId}`} className="btn btn-primary">进入项目</Link>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {error && <p className="text-red">{error}</p>}
            {error.includes('登录') && <Link href="/login" className="btn btn-secondary">去登录</Link>}
            <button className="btn btn-primary" type="button" onClick={joinProject} disabled={joining}>
              {joining ? '加入中...' : '确认加入项目'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
