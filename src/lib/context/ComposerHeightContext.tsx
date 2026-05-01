'use client';

import React, { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';

interface ComposerHeightContextValue {
  composerHeight: number;
  composerRef: React.RefObject<HTMLDivElement | null>;
}

const ComposerHeightContext = createContext<ComposerHeightContextValue>({
  composerHeight: 400,
  composerRef: { current: null },
});

export function useComposerHeight() {
  return useContext(ComposerHeightContext);
}

interface Props {
  children: ReactNode;
}

export function ComposerHeightProvider({ children }: Props) {
  const [composerHeight, setComposerHeight] = useState(400);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.querySelector<HTMLDivElement>('.generation-composer');
    if (!el) return;

    const update = () => setComposerHeight(el.offsetHeight);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <ComposerHeightContext.Provider value={{ composerHeight, composerRef }}>
      {children}
    </ComposerHeightContext.Provider>
  );
}
