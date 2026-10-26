'use client';

import { useEffect, useId, useRef } from 'react';

export type PageExitRisk = { unsaved: string[]; busy: string[]; revision?: string };
type Snapshot = PageExitRisk & { signature: string };
const sources = new Map<string, () => PageExitRisk>();
let approval: { signature: string; expires: number } | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
export function cancelPageExit() { approval = null; clearTimeout(expiry); }

export function getPageExitRisk(): Snapshot {
  const entries = Array.from(sources.entries()).map(([id, read]) => {
    try { return { id, ...read() }; }
    catch { return { id, unsaved: ['当前页面内容暂无法确认是否已保存'], busy: [] }; }
  });
  return {
    unsaved: Array.from(new Set(entries.flatMap(item => item.unsaved))),
    busy: Array.from(new Set(entries.flatMap(item => item.busy))),
    signature: JSON.stringify(entries),
  };
}

export function pageExitApproved() {
  return Boolean(approval && Date.now() < approval.expires && approval.signature === getPageExitRisk().signature);
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (pageExitApproved()) { cancelPageExit(); return; }
  cancelPageExit();
  const risk = getPageExitRisk();
  if (!risk.unsaved.length && !risk.busy.length) return;
  event.preventDefault();
  event.returnValue = '';
}

export function registerPageExitRisk(id: string, read: () => PageExitRisk) {
  if (!sources.size) {
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pageshow', cancelPageExit);
    window.addEventListener('pagehide', cancelPageExit);
    document.addEventListener('input', cancelPageExit, true);
    document.addEventListener('pointerdown', cancelPageExit, true);
    document.addEventListener('keydown', cancelPageExit, true);
  }
  cancelPageExit();
  sources.set(id, read);
  return () => {
    sources.delete(id);
    cancelPageExit();
    if (!sources.size) {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pageshow', cancelPageExit);
      window.removeEventListener('pagehide', cancelPageExit);
      document.removeEventListener('input', cancelPageExit, true);
      document.removeEventListener('pointerdown', cancelPageExit, true);
      document.removeEventListener('keydown', cancelPageExit, true);
    }
  };
}

export function usePageExitRisk(risk: PageExitRisk) {
  const id = useId();
  const current = useRef(risk);
  current.current = risk;
  useEffect(() => registerPageExitRisk(id, () => current.current), [id]);
}

// Approval lives only around the synchronous navigation attempt, not the next user action.
export function runApprovedPageExit(action: () => void, expectedSignature: string) {
  const current = getPageExitRisk();
  if (current.signature !== expectedSignature || current.busy.length) return false;
  cancelPageExit();
  approval = { signature: expectedSignature, expires: Date.now() + 500 };
  expiry = setTimeout(cancelPageExit, 500);
  try { action(); return true; }
  catch { cancelPageExit(); return false; }
}

export function refreshPage(expectedSignature?: string) {
  const risk = getPageExitRisk();
  if (risk.busy.length || (risk.unsaved.length && expectedSignature !== risk.signature)) return false;
  return runApprovedPageExit(() => window.location.reload(), risk.signature);
}
