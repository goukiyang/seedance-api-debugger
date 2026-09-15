'use client';

import { AppSessionProvider } from '@/lib/context/AppSessionContext';
import { ComposerHeightProvider } from '@/lib/context/ComposerHeightContext';
import { InteractionMetricsReporter } from '@/lib/performance/interaction-metrics';
import AppShell from '@/components/AppShell';
import ReleaseNotice from '@/components/ReleaseNotice';

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppSessionProvider>
      <ComposerHeightProvider>
        <InteractionMetricsReporter />
        <AppShell>{children}<ReleaseNotice /></AppShell>
      </ComposerHeightProvider>
    </AppSessionProvider>
  );
}
