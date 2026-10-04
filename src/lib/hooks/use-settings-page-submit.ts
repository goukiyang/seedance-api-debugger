'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { settingsReturnTarget } from '@/lib/navigation/settings-return';

export function useSettingsPageSubmit(drafts: Record<string, unknown>, ready: boolean, fallback: string) {
  const router = useRouter();
  const snapshots = Object.fromEntries(Object.entries(drafts).map(([key, value]) => [key, JSON.stringify(value)]));
  const baseline = useRef<Record<string, string> | null>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const signature = JSON.stringify(snapshots);

  useEffect(() => {
    if (!ready) return;
    const next: Record<string, string> = JSON.parse(signature);
    if (!baseline.current) baseline.current = next;
    if (!completed) return;
    baseline.current[completed] = next[completed];
    setCompleted(null);
    if (Object.keys(next).some(key => next[key] !== baseline.current![key])) {
      lock.current = false;
      setNotice('已保存这项设置；其他设置还有未保存的修改，当前页面已保留。');
      return;
    }
    router.push(settingsReturnTarget(fallback));
  }, [completed, fallback, ready, router, signature]);

  return {
    busy, notice,
    start() {
      if (!ready || lock.current) return false;
      lock.current = true; setBusy(true); setNotice('');
      return true;
    },
    finish(key: string, saved = false) {
      if (saved) setCompleted(key);
      else lock.current = false;
      setBusy(false);
    },
  };
}
