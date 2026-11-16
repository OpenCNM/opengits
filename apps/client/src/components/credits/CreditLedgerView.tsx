'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Zap, TrendingUp, TrendingDown, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { useUserCreditsStore } from '@/lib/stores/user-credits-store';

interface LedgerEntry {
  id: string;
  amount: number;
  source: string;
  repositoryId: string | null;
  repoLabel: string | null;
  detail: string | null;
  at: string;
}

interface LedgerResponse {
  entries: LedgerEntry[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
  balance: number;
  savedRepos: number;
}

/** source 注册表：统一渲染标签（禁止散落 switch/字符串匹配） */
export const SOURCE_LABEL: Record<string, () => string> = {
  JIT_FIRST_TRANSLATE: () => m.credits_source_jit(),
  MARKET_BASE: () => m.credits_source_market_base(),
  MARKET_BONUS: () => m.credits_source_market_bonus(),
  IMPORT: () => m.credits_source_import(),
  IMPORT_REWARD: () => m.credits_source_import(),
  SHELF_FEE: () => m.credits_source_shelf_fee(),
  SIGNUP_GIFT: () => m.credits_source_signup_gift(),
  RETRANSLATE_REWARD: () => m.credits_source_retranslate(),
  PUBLISH_GIFT: () => m.credits_source_publish_gift(),
  CANONICAL_BONUS: () => m.credits_source_canonical_bonus(),
};

export function resolveCreditSourceLabel(source: string): string {
  return SOURCE_LABEL[source]?.() ?? source;
}


export function CreditLedgerView() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchLedger = useCallback(async (targetPage: number) => {
    setLoading(true);
    try {
      const res = await api.get<LedgerResponse>(`/api/user/credits/ledger?page=${targetPage}`, {
        onUnauthorized: 'redirect',
      });
      setData(res);
      if (typeof res?.balance === 'number') {
        useUserCreditsStore.getState().setBalance(res.balance);
      }
    } catch (err) {
      // 容错降级: 账单拉取失败展示空态（余额以本地 store 兜底），留痕排查
      console.warn('[credit-ledger] fetch failed:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLedger(page);
  }, [fetchLedger, page]);

  return (
    <div className="space-y-4 font-sans text-theme-foreground">
      <div className="border-b border-theme-border/40 pb-3 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Zap size={18} className="text-amber-500 fill-amber-500/20" />
            {m.credits_ledger_title()}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void fetchLedger(page)}
          className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
          title={m.common_refresh()}
          aria-label={m.common_refresh()}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {data && (
        <div className="flex items-center gap-4 px-4 py-3 rounded-xl border border-theme-border/60 bg-theme-surface/40">
          <div className="flex items-center gap-1.5 text-sm">
            <Zap size={14} className="text-amber-500 fill-amber-500/20" />
            <span className="font-mono font-bold">{data.balance.toLocaleString()}</span>
            <span className="text-theme-muted text-xs">{m.credits_balance_bucket()}</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-theme-border/60 bg-theme-surface/30 p-2 min-h-[200px]">
        {loading ? (
          <p className="text-xs text-theme-muted text-center py-10">{m.common_loading()}</p>
        ) : !data || data.entries.length === 0 ? (
          <p className="text-xs text-theme-muted text-center py-10 leading-relaxed">
            {m.credits_ledger_empty()}
          </p>
        ) : (
          <div className="divide-y divide-theme-border/30">
            {data.entries.map((entry) => {
              const positive = entry.amount > 0;
              const label = resolveCreditSourceLabel(entry.source);
              return (
                <div key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    className={cn(
                      'inline-flex items-center justify-center w-7 h-7 rounded-lg border shrink-0',
                      positive
                        ? 'text-emerald-600 border-emerald-500/30 bg-emerald-500/5'
                        : 'text-theme-accent border-theme-accent/30 bg-theme-accent/5'
                    )}
                  >
                    {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-theme-foreground truncate">{label}</span>
                      {entry.repoLabel && (
                        <span className="text-micro text-theme-muted font-mono truncate">{entry.repoLabel}</span>
                      )}
                    </div>
                    <span className="text-micro text-theme-muted font-mono">
                      {new Date(entry.at).toLocaleString()}
                      {entry.detail ? ` · ${entry.detail}` : ''}
                    </span>
                  </div>
                  <span
                    className={cn(
                      'font-mono text-sm font-semibold shrink-0',
                      positive ? 'text-emerald-600' : 'text-theme-accent'
                    )}
                  >
                    {positive ? '+' : ''}
                    {entry.amount.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-theme-muted">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-theme-border/60 hover:bg-theme-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={13} />
            {m.docs_prev_chapter()}
          </button>
          <span className="font-mono">
            {data.pagination.page} / {data.pagination.totalPages}
          </span>
          <button
            type="button"
            disabled={page >= data.pagination.totalPages}
            onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-theme-border/60 hover:bg-theme-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m.docs_next_chapter()}
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
