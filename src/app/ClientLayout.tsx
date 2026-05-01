'use client';

import { ComposerHeightProvider } from '@/lib/context/ComposerHeightContext';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ComposerHeightProvider>{children}</ComposerHeightProvider>;
}
