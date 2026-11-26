'use client';

import { useEffect, useRef } from 'react';

interface RepoViewBeaconProps {
  repositoryId?: string;
}

export function RepoViewBeacon({ repositoryId }: RepoViewBeaconProps) {
  const reportedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!repositoryId || reportedIdRef.current === repositoryId) return;
    reportedIdRef.current = repositoryId;

    fetch(`/api/repos/${repositoryId}/view`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => {});
  }, [repositoryId]);

  return null;
}
