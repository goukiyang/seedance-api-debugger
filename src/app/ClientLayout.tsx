'use client';

import { ComposerHeightProvider } from '@/lib/context/ComposerHeightContext';
import AppShell from '@/components/AppShell';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <ComposerHeightProvider>
      <AppShell>{children}</AppShell>
    </ComposerHeightProvider>
  );
}
