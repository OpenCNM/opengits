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
    }
  }

  void signIn('github', { callbackUrl });
}
