'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

type InteractionMetric = {
  name: string;
  duration: number;
  detail?: string;
};

const DEV_METRIC_PREFIX = '[sd2:perf]';

function canLogMetrics() {
  return process.env.NODE_ENV !== 'production' && typeof window !== 'undefined';
}

export function recordInteractionMetric(metric: InteractionMetric) {
  if (!canLogMetrics()) return;
  const duration = `${Math.round(metric.duration)}ms`;
  if (metric.detail) {
    // eslint-disable-next-line no-console
    console.debug(DEV_METRIC_PREFIX, metric.name, duration, metric.detail);
    return;
  }
  // eslint-disable-next-line no-console
  console.debug(DEV_METRIC_PREFIX, metric.name, duration);
}

export function assetGridProfilerOnRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
) {
  recordInteractionMetric({
    name: `${id}:${phase}`,
    duration: actualDuration,
  });
}

export function InteractionMetricsReporter() {
  const pathname = usePathname();
  const routeStartedAt = useRef(typeof performance === 'undefined' ? 0 : performance.now());
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (!canLogMetrics()) return;
    const now = performance.now();
    if (previousPathname.current !== pathname) {
      recordInteractionMetric({
        name: 'route-visible',
        duration: now - routeStartedAt.current,
        detail: `${previousPathname.current} -> ${pathname}`,
      });
      previousPathname.current = pathname;
    }
    routeStartedAt.current = now;
  }, [pathname]);

  useEffect(() => {
    if (!canLogMetrics() || typeof PerformanceObserver === 'undefined') return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          recordInteractionMetric({
            name: 'long-task',
            duration: entry.duration,
            detail: entry.name,
          });
        });
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      observer = null;
    }
    return () => {
      observer?.disconnect();
    };
  }, []);

  return null;
}
