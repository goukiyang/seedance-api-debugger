import { Suspense } from 'react';
import WorksWorkspace from '@/components/works/WorksWorkspace';

export default function WorksPage() {
  return <Suspense fallback={<div className="container" role="status">正在读取作品…</div>}><WorksWorkspace /></Suspense>;
}
