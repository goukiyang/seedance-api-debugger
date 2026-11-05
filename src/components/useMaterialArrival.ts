'use client';

import { useEffect, useRef, useState } from 'react';

export function useMaterialArrival(scope: string) {
  const [arrival, setArrival] = useState<{ scope: string; ids: string[] } | null>(null);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => setArrival(null), 2400);
    return () => window.clearTimeout(timer);
  }, [arrival]);
  return {
    arrived: arrival?.scope === scope ? arrival.ids : undefined,
    mark(ids: string[]) {
      if (ids.length && liveScope.current === scope) setArrival({ scope, ids });
    },
  };
}
