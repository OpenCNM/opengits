'use client';

import * as m from '@/paraglide/messages';
import { useState } from 'react';
import { Trash2, User, RefreshCw, Download } from 'lucide-react';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import { signOut, signIn } from 'next-auth/react';
import { SettingsShell } from '@/components/settings/SettingsShell';

export default function AccountSettingsPage() {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (confirmText !== 'DELETE') {
      toastManager.add({ type: 'warning', title: m.account_delete_confirm_input_title(), description: m.account_delete_confirm_hint() });
      return;
    }
    if (!window.confirm(m.account_delete_dialog_prompt())) return;
    setDeleting(true);
    try {
      // 用户主动操作 → 401 走默认登录引导（api helper 按统一信封解包/抛错）
      await api.delete('/api/account/delete', { body: { confirm: 'DELETE' } });
      toastManager.add({ type: 'success', title: m.account_deleted_title(), description: m.account_deleted_desc() });
      signOut({ callbackUrl: '/' });
    } catch (err: unknown) {
      toastManager.add({
        type: 'error',
        title: m.account_delete_failed(),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SettingsShell activeTab="account">
      <div className="border-b border-theme-border/40 pb-4">
        <h1 className="text-2xl font-bold text-theme-foreground tracking-tight flex items-center gap-2.5">
          <User size={22} className="text-theme-primary" />
          {m.user_menu_account()}
        </h1>
      </div>

      {/* GitHub 账号授权 */}
      <div className="p-4 sm:p-5 rounded-xl border border-theme-border/60 bg-theme-surface space-y-3 shadow-2xs">
        <h2 className="text-sm font-semibold text-theme-foreground flex items-center gap-2">
          <GithubIcon className="w-4 h-4 text-theme-primary" />
          {m.account_github_auth_title()}
        </h2>
        <p className="text-xs sm:text-sm text-theme-muted leading-relaxed">
          {m.account_github_auth_desc()}
        </p>
        <div className="pt-1">
          <button
            onClick={() => signIn('github', { callbackUrl: '/settings/account' })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-theme-primary text-theme-primary-fg hover:opacity-90 text-sm font-medium transition-opacity cursor-pointer shadow-2xs"
          >
            <RefreshCw size={14} />
            {m.account_github_reauth_btn()}
          </button>
        </div>
      </div>

      {/* 数据导出（GDPR 可携带权）：GET 附件直链，session cookie 鉴权 */}
      <div className="p-4 sm:p-5 rounded-xl border border-theme-border/60 bg-theme-surface space-y-3 shadow-2xs">
        <h2 className="text-sm font-semibold text-theme-foreground flex items-center gap-2">
          <Download size={16} className="text-theme-primary" />
          {m.account_export_title()}
        </h2>
        <p className="text-xs sm:text-sm text-theme-muted leading-relaxed">
          {m.account_export_desc()}
        </p>
        <div className="pt-1">
          <a
            href="/api/account/export"
            download
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-theme-border/70 text-theme-foreground hover:bg-theme-surface/80 text-sm font-medium transition-colors cursor-pointer shadow-2xs"
          >
            <Download size={14} />
            {m.account_export_btn()}
          </a>
        </div>
      </div>

      {/* 账号注销 */}
      <div className="p-4 sm:p-5 rounded-xl border border-rose-500/30 bg-rose-500/5 space-y-3">
        <h2 className="text-sm font-semibold text-rose-600 flex items-center gap-2">
          <Trash2 size={16} />
          {m.account_delete_title()}
        </h2>
        <p className="text-xs sm:text-sm text-theme-muted leading-relaxed">
          {m.account_delete_desc()}
        </p>
        <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={m.placeholder_confirm_delete()}
            className="flex-1 px-3.5 py-2 rounded-lg border border-theme-border/60 bg-theme-bg text-sm font-mono outline-none focus:border-rose-500/50 placeholder:text-theme-muted"
          />
          <button
            onClick={handleDelete}
            disabled={deleting || confirmText !== 'DELETE'}
            className="shrink-0 px-4 py-2 rounded-lg border border-rose-500/50 text-rose-500 hover:bg-rose-500/10 text-sm font-medium transition-colors disabled:opacity-40 cursor-pointer"
          >
            {deleting ? m.account_deleting_btn() : m.account_delete_btn()}
          </button>
        </div>
      </div>
    </SettingsShell>
  );
}
