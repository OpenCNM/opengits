import { signIn } from 'next-auth/react';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { savePendingImportReauth, recordReauthAttempt } from '@/lib/stores/pending-import-reauth';
import { getDashboardSnapshot } from '@/lib/stores/dashboard-keepalive-store';

export interface TriggerGithubReauthOptions {
  url?: string;
  createEdition?: boolean;
  targetLanguage?: string;
  isPublic?: boolean;
  importMode?: 'github' | 'web';
}

/**
 * 触发向导上下文保护的 GitHub OAuth 重新授权。
 * 1. 保存当前未完成的导入向导状态到 sessionStorage
 * 2. 记录尝试时间戳（供防死循环冷却检测使用）
 * 3. 构造保持当前页码与路由的 callbackUrl
 * 4. 调用 signIn('github') 唤起 OAuth 授权重定向
 */
export function triggerGithubReauth(options?: TriggerGithubReauthOptions): void {
  const wizardState = useImportWizardStore.getState();
  savePendingImportReauth({
    url: options?.url || wizardState.url,
    createEdition: options?.createEdition ?? wizardState.createEdition,
    targetLanguage: options?.targetLanguage ?? wizardState.targetLanguage,
    isPublic: options?.isPublic ?? wizardState.isPublic,
    importMode: options?.importMode ?? wizardState.importMode,
  });
  recordReauthAttempt();

  let callbackUrl = typeof window !== 'undefined' ? window.location.href : '/';
  if (typeof window !== 'undefined') {
    try {
      const urlObj = new URL(window.location.href);
      const snapshot = getDashboardSnapshot();
      if (snapshot.currentPage > 1 && !urlObj.searchParams.has('page')) {
        urlObj.searchParams.set('page', String(snapshot.currentPage));
      }
      callbackUrl = urlObj.toString();
    } catch {
      // 容错降级: URL 解析异常时安全回退至 window.location.href 原值
    }
  }

  void signIn('github', { callbackUrl });
}
