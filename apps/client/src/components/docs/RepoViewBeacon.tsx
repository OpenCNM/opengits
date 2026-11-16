'use client';

import { useEffect, useRef } from 'react';

interface RepoViewBeaconProps {
  /** 仓库未解析（404 等）时可为空，此时不上报 */
  repositoryId?: string;
}

/**
 * 阅读量上报：进入阅读页时向 view 端点发一次 fire-and-forget POST。
 * ref 按仓库 id 记账——同仓内切页/StrictMode 双触发不重复上报；
 * 服务端另有「用户/IP + 仓库」窗口去重兜底。
 */
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
