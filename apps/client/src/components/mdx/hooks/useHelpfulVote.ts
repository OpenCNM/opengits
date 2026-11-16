'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';

interface UseHelpfulVoteOptions {
  owner: string;
  repo: string;
  initialCount: number;
  initialVoted: boolean;
}

export function useHelpfulVote({
  owner,
  repo,
  initialCount,
  initialVoted,
}: UseHelpfulVoteOptions) {
  const [count, setCount] = useState(initialCount);
  const [voted, setVoted] = useState(initialVoted);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await api.post<{ voted: boolean; helpfulCount?: number }>(
        `/api/repos/${owner}/helpful?repo=${encodeURIComponent(repo)}`,
        undefined,
        { onUnauthorized: 'throw' }
      );
      setVoted(data.voted);
      setCount(data.helpfulCount ?? count);
    } catch (err: any) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  return {
    count,
    voted,
    busy,
    toggle,
  };
}
