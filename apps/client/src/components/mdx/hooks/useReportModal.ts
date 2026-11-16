'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';

interface UseReportModalOptions {
  owner: string;
  repo: string;
  repoId?: string;
}

export function useReportModal({ owner, repo, repoId }: UseReportModalOptions) {
  const [reason, setReason] = useState<string>('LOW_QUALITY');
  const [detail, setDetail] = useState('');
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post('/api/reports', {
        owner,
        repo,
        repositoryId: repoId,
        reason,
        detail: detail.trim() || undefined,
      });
      toastManager.add({
        type: 'success',
        title: m.report_submitted_title(),
        description: m.report_submitted_desc(),
      });
      setOpen(false);
      setDetail('');
    } catch (err: any) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err?.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return {
    reason,
    setReason,
    detail,
    setDetail,
    open,
    setOpen,
    submitting,
    submit,
  };
}
