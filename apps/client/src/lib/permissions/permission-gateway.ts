'use client';

import { usePermissionStore } from './permission-store';
import { requireApiKey } from '@/lib/api-key-guard';
import * as m from '@/paraglide/messages';
import type { PermissionLevel, SignInOptionsArgs } from './types';

/**
 * 探针式权限拦截：满足权限则执行 action，不满足则唤起对应的统一拦截弹窗
 * 返回 boolean 指示操作是否已立即同步放行执行
 */
export function withPermission(
  level: PermissionLevel,
  action: () => void | Promise<void>,
  options?: {
    actionTitle?: string;
    contextText?: string;
  }
): boolean {
  // 🟢 级：查看公开教程、AST 拓扑、搜索过滤（游客完全放行）
  if (level === 'READ') {
    void action();
    return true;
  }

  const { isAuthenticated } = usePermissionStore.getState();

  // 🟡 级：收藏书架、管理专属 MCP Token、任务认领（需 GitHub 登录）
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

  // 🔴 级：转录新仓库、AI 划词问答、章节重新翻译（需 GitHub + API Key）
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

/** 语法糖：需要正式用户身份（如收藏书架、导出 MCP Token、认领接力） */
export const requireAuth = (
  action: () => void | Promise<void>,
  contextText?: string,
  actionTitle?: string
): boolean => withPermission('USER_ASSET', action, { contextText, actionTitle });

/** 语法糖：需要 AI 计算能力（如新仓库转录、AI 划词对话、章节重新翻译） */
export const requireAiCapability = (
  action: () => void | Promise<void>,
  contextText?: string,
  actionTitle?: string
): boolean => withPermission('AI_COMPUTE', action, { contextText, actionTitle });

/** 语法糖：打开双通道登录选择弹窗 (GitHub vs 游客) */
export const promptSignInOptions = (args?: SignInOptionsArgs): void => {
  usePermissionStore.getState().openSignInOptions(args);
};
