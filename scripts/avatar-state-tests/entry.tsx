import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarStudio from '../../src/app/tools/avatar-studio/studio';
import { AppSessionProvider, useAppSession } from '../../src/lib/context/AppSessionContext';

function Fixture() {
  const { credits, refreshUser, refreshCredits } = useAppSession();
  const [ready, setReady] = useState(false);
  useEffect(() => { void (async () => {
    await refreshUser(); await refreshCredits(); setReady(true);
  })(); }, [refreshUser, refreshCredits]);
  return <><output aria-label="模拟余额">{credits?.available ?? '未确认'}</output>
    {ready && <AvatarStudio ownerId="fixture-owner" />}</>;
}

createRoot(document.getElementById('root')!).render(<AppSessionProvider><Fixture /></AppSessionProvider>);
