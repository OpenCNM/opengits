'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Switch } from '@/components/ui/switch';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';

/**
 * 维护者的"自动同步上游更新"开关（仅教程维护者可见，由服务端判定后挂载）。
 * 开启 = 授权系统用维护者的模型自动维护公共副本（不删除章节）。
 */
export function AutoSyncSwitch({
  owner,
  repo,
  enabled,
  onChange,
  className,
}: {
  owner: string;
  repo: string;
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  className?: string;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(enabled);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setChecked(enabled);
  }, [enabled]);

  const toggle = async (next: boolean) => {
    setPending(true);
    try {
      await api.patch(`/api/repos/${owner}/${repo}/auto-sync`, { enabled: next });
      setChecked(next);
      onChange?.(next);
      toastManager.add({ type: 'success', title: next ? m.toast_auto_sync_enabled() : m.toast_auto_sync_disabled() });
      router.refresh();
    } catch (err) {
      // 服务端拒绝：本地状态回弹
      toastManager.add({ type: 'warning', title: m.toast_save_failed(), description: (err as Error)?.message || m.common_retry_later() });
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-theme-surface border border-theme-border/80 text-xs font-sans transition-colors',
        className
      )}
      title={m.auto_sync_desc()}
    >
      <span className="text-micro font-medium text-theme-muted">{m.auto_sync_label()}</span>
      <Switch checked={checked} disabled={pending} onCheckedChange={(v) => toggle(v === true)} aria-label={m.auto_sync_label()} />
    </div>
  );
}
