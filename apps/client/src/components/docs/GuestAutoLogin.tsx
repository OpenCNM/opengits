'use client';

import { useEffect } from 'react';
import { useSafeSession } from '@/lib/useSafeSession';
import { useGuestStore } from '@/lib/stores/guest-store';

export interface GuestAutoLoginProps {
  active: boolean;
  repoSlug: string;
}

export function GuestAutoLogin({ active, repoSlug }: GuestAutoLoginProps) {
  const { status } = useSafeSession();

  useEffect(() => {
    if (!active || status !== 'unauthenticated') return;
    const state = useGuestStore.getState();
    if (!state.isGuest || state.lastViewedRepo !== repoSlug) {
      state.enableGuestMode(repoSlug);
    }
  }, [active, status, repoSlug]);

  return null;
}
