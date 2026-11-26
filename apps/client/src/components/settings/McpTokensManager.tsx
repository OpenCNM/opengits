'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, Copy, Check, Cpu, AlertTriangle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { useClipboard } from '@/hooks/useClipboard';
import * as m from '@/paraglide/messages';

import { maskToken } from '@/components/mcp-connect/mcp-client-configs';

interface McpTokenItem {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface NewTokenResult {
  id: string;
  name: string;
  prefix: string;
  plainToken: string;
  createdAt: string;
}

function formatTime(value: string | null): string {
  if (!value) return m.tokens_never_used();
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface McpTokenCreatedPayload {
  id?: string;
  name: string;
  prefix: string;
  plainToken: string;
}

export function McpTokensManager({
  isModal = false,
  refreshTrigger = 0,
  onTokenCreated,
  onTokenRevoked,
}: {
  isModal?: boolean;
  refreshTrigger?: number;
  onTokenCreated?: (token: McpTokenCreatedPayload) => void;
  onTokenRevoked?: (id: string) => void;
}) {
  const [tokens, setTokens] = useState<McpTokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<NewTokenResult | null>(null);
  const [showPlainToken, setShowPlainToken] = useState(false);
  const { copy, isCopied } = useClipboard({ showToast: false });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<McpTokenItem | null>(null);
  const [error, setError] = useState('');

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp/tokens');
      if (!res.ok) throw new Error(m.toast_action_failed());
      const data = await res.json();
      setTokens(data.data?.tokens || data.tokens || []);
    } catch {
      setError(m.toast_action_failed());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens, refreshTrigger]);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(m.tokens_name_required());
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/mcp/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || data?.error || m.toast_action_failed());
      }
      const data = await res.json();
      const created = data.data?.token || data.token;
      setNewToken(created);
      if (created?.plainToken) {
        onTokenCreated?.({
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          plainToken: created.plainToken,
        });
      }
      setShowPlainToken(false);
      setName('');
      await fetchTokens();
    } catch (err: any) {
      setError(err.message || m.toast_action_failed());
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError('');
    try {
      const res = await fetch(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(m.common_delete_failed());
      setTokens((prev) =>
        prev.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t))
      );
      onTokenRevoked?.(id);
    } catch (err: any) {
      setError(err.message || m.common_delete_failed());
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopy = async () => {
    if (!newToken?.plainToken) return;
    await copy(newToken.plainToken, 'new-token');
  };

  return (
    <div className="space-y-4 font-sans text-theme-foreground">
      {!isModal && (
        <div className="border-b border-theme-border/40 pb-4">
          <h1 className="text-2xl font-bold text-theme-foreground tracking-tight flex items-center gap-2.5">
            <KeyRound size={22} className="text-theme-primary" />
            {m.tokens_title()}
          </h1>
          <p className="text-sm text-theme-muted mt-1.5 leading-relaxed">
            {m.tokens_subtitle()}
          </p>
        </div>
      )}

      <div className="p-4 sm:p-5 rounded-xl border border-theme-border/60 bg-theme-surface/30 space-y-3.5">
        <h2 className="text-sm font-semibold text-theme-foreground flex items-center gap-2">
          <Plus size={16} className="text-theme-primary" />
          {m.tokens_create_new()}
        </h2>
        <div className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder={m.tokens_input_placeholder()}
            maxLength={50}
            className="flex-1 px-3.5 py-2 rounded-lg text-sm font-sans text-theme-foreground bg-theme-bg border border-theme-border/60 focus:border-theme-primary focus:outline-none placeholder:text-theme-muted"
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-theme-bg bg-theme-primary hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer select-none shrink-0 shadow-2xs"
          >
            {creating ? <RefreshCw size={15} className="animate-spin" /> : <KeyRound size={15} />}
            {creating ? m.tokens_generating() : m.tokens_generate()}
          </button>
        </div>
        {error && (
          <p className="text-sm text-theme-accent flex items-center gap-1.5">
            <AlertTriangle size={14} />
            {error}
          </p>
        )}
      </div>

      {newToken && (
        <div className="p-4 space-y-3 border border-theme-primary/40 bg-theme-primary/5 rounded-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-theme-foreground flex items-center gap-2">
              <Check size={16} className="text-emerald-500" />
              {m.tokens_generated_title({ name: newToken.name })}
            </h2>
            <span className="text-xs text-theme-muted">{m.tokens_copy_immediate_hint()}</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2.5 items-stretch">
            <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono text-theme-foreground bg-theme-bg border border-theme-border/60 break-all select-all flex items-center">
              {showPlainToken ? newToken.plainToken : maskToken(newToken.plainToken)}
            </code>
            <button
              onClick={() => setShowPlainToken((prev) => !prev)}
              type="button"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm text-theme-muted border border-theme-border/60 hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer select-none shrink-0"
              title={showPlainToken ? m.tokens_hide_plain() : m.common_view()}
            >
              {showPlainToken ? <EyeOff size={15} /> : <Eye size={15} />}
              <span>{showPlainToken ? m.tokens_hide_plain() : m.common_view()}</span>
            </button>
            <button
              onClick={handleCopy}
              type="button"
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-sm text-theme-primary border border-theme-primary/40 bg-theme-primary/10 hover:bg-theme-primary/20 transition-colors cursor-pointer select-none shrink-0 font-medium"
            >
              {isCopied('new-token') ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
              <span>{isCopied('new-token') ? m.common_copied() : m.common_copy()}</span>
            </button>
          </div>
        </div>
      )}

      <div className="p-4 sm:p-5 rounded-xl border border-theme-border/60 bg-theme-surface/30 space-y-3">
        <h2 className="text-sm font-semibold text-theme-foreground flex items-center gap-2">
          <Cpu size={16} className="text-theme-primary" />
          {m.tokens_created_list()} ({tokens.length})
        </h2>

        {loading ? (
          <p className="text-sm text-theme-muted py-6 text-center">{m.common_loading()}</p>
        ) : tokens.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <KeyRound size={26} className="mx-auto text-theme-muted opacity-60" />
            <p className="text-sm text-theme-muted">{m.tokens_empty_hint()}</p>
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-theme-border/40 text-left text-xs text-theme-muted">
                  <th className="py-2.5 px-3 font-medium">{m.tokens_th_name()}</th>
                  <th className="py-2.5 px-3 font-medium">{m.tokens_th_hash()}</th>
                  <th className="py-2.5 px-3 font-medium">{m.tokens_th_last_used()}</th>
                  <th className="py-2.5 px-3 text-right font-medium">{m.tokens_th_action()}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/20">
                {tokens.map((token) => {
                  const isRevoked = Boolean(token.revokedAt);
                  return (
                    <tr
                      key={token.id}
                      className={`hover:bg-theme-surface/50 transition-colors ${
                        isRevoked ? 'opacity-60' : ''
                      }`}
                    >
                      <td className="py-3 px-3 font-medium text-theme-foreground">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm ${isRevoked ? 'line-through text-theme-muted' : ''}`}>{token.name}</span>
                          <span
                            className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
                              !isRevoked
                                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
                                : 'bg-theme-surface border-theme-border text-theme-muted'
                            }`}
                          >
                            {!isRevoked ? m.tokens_status_active() : m.tokens_status_revoked()}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-sm text-theme-foreground/80">{maskToken(token.prefix)}</td>
                      <td className="py-3 px-3 text-theme-muted text-sm">{formatTime(token.lastUsedAt)}</td>
                      <td className="py-3 px-3 text-right">
                        {!isRevoked ? (
                          <div className="inline-flex items-center justify-end gap-2">
                            <Popover
                              open={tokenToDelete?.id === token.id}
                              onOpenChange={(open) => !open && setTokenToDelete(null)}
                            >
                              <PopoverTrigger
                                onClick={() => setTokenToDelete(token)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-theme-accent border border-theme-accent/40 hover:bg-theme-accent/10 transition-colors cursor-pointer select-none"
                                title={m.tokens_action_revoke()}
                              >
                                <Trash2 size={13} />
                                <span>{m.tokens_action_revoke()}</span>
                              </PopoverTrigger>
                              <PopoverPopup
                                side="top"
                                align="end"
                                className="p-3.5 bg-theme-bg border border-theme-border shadow-xl rounded-xl w-64 z-50 text-left font-sans"
                              >
                                <p className="text-sm font-bold text-theme-foreground">{m.common_confirm_delete()}</p>
                                <p className="text-xs text-theme-muted mt-1 leading-relaxed">
                                  {m.tokens_delete_warning()}
                                </p>
                                <div className="mt-3 flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setTokenToDelete(null)}
                                    className="px-2.5 py-1 rounded-md text-xs text-theme-muted hover:text-theme-foreground hover:bg-theme-surface border border-theme-border/60 transition-colors cursor-pointer select-none"
                                  >
                                    {m.common_cancel()}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const id = token.id;
                                      setTokenToDelete(null);
                                      void handleDelete(id);
                                    }}
                                    disabled={deletingId === token.id}
                                    className="px-2.5 py-1 rounded-md text-xs bg-theme-accent text-white hover:bg-theme-accent/90 transition-colors cursor-pointer font-medium disabled:opacity-50 select-none"
                                  >
                                    {deletingId === token.id ? m.common_deleting() : m.tokens_action_revoke()}
                                  </button>
                                </div>
                              </PopoverPopup>
                            </Popover>
                          </div>
                        ) : (
                          <span className="text-xs text-theme-muted font-mono">{m.tokens_status_revoked()}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default McpTokensManager;
