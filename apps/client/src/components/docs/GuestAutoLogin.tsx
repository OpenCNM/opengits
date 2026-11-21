'use client';

import { useEffect } from 'react';
import { useSafeSession } from '@/lib/useSafeSession';
import { useGuestStore } from '@/lib/stores/guest-store';

export interface GuestAutoLoginProps {
  /** 仅当未登录访问公开教程时启用 */
  active: boolean;
  /** 当前访问的仓库标识（owner/repo） */
  repoSlug: string;
}

/**
 * 访客自动登录态激活器：
 * 当未登录或无账号用户打开公开教程分享链接时，自动以游客身份激活会话，
 * 确保返回书架、个人菜单与跨页阅读均直接处于游客已登录态。
 */
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
