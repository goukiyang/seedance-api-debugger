'use client';

import { AppSessionProvider } from '@/lib/context/AppSessionContext';
import { ComposerHeightProvider } from '@/lib/context/ComposerHeightContext';
import { InteractionMetricsReporter } from '@/lib/performance/interaction-metrics';
import AppShell from '@/components/AppShell';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppSessionProvider>
      <ComposerHeightProvider>
        <InteractionMetricsReporter />
        <AppShell>{children}</AppShell>
      </ComposerHeightProvider>
    </AppSessionProvider>
  );
}
