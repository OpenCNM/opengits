'use client';

import { usePermissionStore } from './permission-store';
import { requireApiKey } from '@/lib/api-key-guard';
import * as m from '@/paraglide/messages';
import type { PermissionLevel, SignInOptionsArgs } from './types';

export function withPermission(
  level: PermissionLevel,
  action: () => void | Promise<void>,
  options?: {
    actionTitle?: string;
    contextText?: string;
  }
): boolean {
  if (level === 'READ') {
    void action();
    return true;
  }

  const { isAuthenticated } = usePermissionStore.getState();

  if (level === 'USER_ASSET') {
    if (isAuthenticated) {
      void action();
      return true;
    }
    usePermissionStore.getState().openPermissionGate({
      level: 'USER_ASSET',
      title: options?.actionTitle || m.gate_user_asset_title(),
      contextText: options?.contextText || m.gate_user_asset_desc(),
      onResolved: action,
    });
    return false;
  }

  if (level === 'AI_COMPUTE') {
    if (!isAuthenticated) {
      usePermissionStore.getState().openPermissionGate({
        level: 'AI_COMPUTE',
        title: options?.actionTitle || m.gate_ai_compute_title(),
        contextText: options?.contextText || m.gate_ai_compute_desc(),
        onResolved: () => {
          requireApiKey(() => void action(), options?.contextText);
        },
      });
      return false;
    }

    return requireApiKey(() => void action(), options?.contextText);
  }

  return false;
}

export const requireAuth = (
  action: () => void | Promise<void>,
  contextText?: string,
  actionTitle?: string
): boolean => withPermission('USER_ASSET', action, { contextText, actionTitle });

export const requireAiCapability = (
  action: () => void | Promise<void>,
  contextText?: string,
  actionTitle?: string
): boolean => withPermission('AI_COMPUTE', action, { contextText, actionTitle });

export const promptSignInOptions = (args?: SignInOptionsArgs): void => {
  usePermissionStore.getState().openSignInOptions(args);
};
