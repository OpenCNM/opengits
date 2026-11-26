'use client';

import { useState, useEffect } from 'react';
import { InkSpirit } from './InkSpirit';

interface AssistantContainerProps {
  owner: string;
  repo: string;
  repositoryId?: string;
}

export function AssistantContainer({ owner, repo, repositoryId }: AssistantContainerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return <InkSpirit owner={owner} repo={repo} repositoryId={repositoryId} />;
}

