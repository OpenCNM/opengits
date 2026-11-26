'use client';

import React from 'react';
import { Monitor, SlidersHorizontal, ArrowUpRight } from 'lucide-react';
import * as m from '@/paraglide/messages';

export interface ActiveClientItem {
  id?: string;
  name: string;
  version?: string | null;
  status: 'online' | 'recent';
  totalCalls?: number;
  hitCalls?: number;
  recentTicks?: number[];
}

interface DashboardMcpClientsPanelProps {
  clients: ActiveClientItem[];
  onOpenWizard: () => void;
}

export function DashboardMcpClientsPanel({ clients, onOpenWizard }: DashboardMcpClientsPanelProps) {
  const isAnyOnline = clients.some((c) => c.status === 'online');

  return (
    <button
      type="button"
      onClick={onOpenWizard}
      className="block w-full text-left p-3 rounded-xl bg-theme-surface/70 border border-theme-border/70 hover:border-theme-foreground/20 hover:bg-theme-surface/90 space-y-2 font-sans transition-colors cursor-pointer group outline-none focus-visible:ring-2 focus-visible:ring-theme-primary/40"
    >
      <span className="flex items-center justify-between select-none">
        <span className="flex items-center gap-2 min-w-0">
          <span className="relative flex items-center justify-center shrink-0">
            <Monitor className="w-3.5 h-3.5 text-theme-foreground/80" />
            <span
              className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${
                isAnyOnline
                  ? 'bg-emerald-500 animate-pulse'
                  : clients.length > 0
                    ? 'bg-theme-muted/60'
                    : 'bg-theme-muted/40'
              }`}
            />
          </span>
          <span className="text-xs font-semibold text-theme-foreground truncate">
            {m.dashboard_mcp_clients()}
          </span>
        </span>

        <span className="text-micro font-mono text-theme-muted group-hover:text-theme-foreground flex items-center gap-1 transition-colors shrink-0">
          {clients.length > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-0.5">
              <span>{m.dashboard_mcp_online_badge({ name: clients[0].name })}</span>
              <ArrowUpRight className="w-2.5 h-2.5" />
            </span>
          ) : (
            <span className="flex items-center gap-0.5">
              <span>{m.search_configure()}</span>
              <SlidersHorizontal className="w-2.5 h-2.5" />
            </span>
          )}
        </span>
      </span>

      {clients.length === 0 ? (
        <span className="block text-micro text-theme-muted/80 leading-relaxed font-sans">
          {m.dashboard_connect_hint()}
        </span>
      ) : (
        <span className="block space-y-2 pt-1 border-t border-theme-border/40">
          {clients.map((client) => {
            const total = client.totalCalls ?? 0;
            const hits = client.hitCalls ?? 0;
            const hitRate = total > 0 ? Math.round((hits / total) * 100) : 100;
            const ticks = client.recentTicks && client.recentTicks.length > 0 ? client.recentTicks : [];
            const isOnline = client.status === 'online';

            return (
              <span key={client.name} className="block space-y-1">
                <span className="flex items-center justify-between text-micro font-mono">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-theme-muted/60'
                      }`}
                    />
                    <span className="font-semibold text-theme-foreground truncate">
                      {client.name}
                    </span>
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">
                    {total > 0 ? `${hitRate}%` : m.dashboard_connected()}
                  </span>
                </span>

                <span className="flex items-center justify-between text-micro font-mono text-theme-muted">
                  <span>{m.dashboard_recent_calls()} ({total})</span>
                  <span className="flex items-end gap-1 h-2.5">
                    {ticks.length > 0 ? (
                      ticks.map((hit, idx) => (
                        <span
                          key={idx}
                          className={`w-1 rounded-xs transition-all ${
                            hit === 1
                              ? 'h-2.5 bg-emerald-500'
                              : 'h-1.5 bg-theme-muted/40'
                          }`}
                          title={hit === 1 ? m.dashboard_mcp_hit_success() : m.dashboard_mcp_hit_miss()}
                        />
                      ))
                    ) : (
                      <span className="text-theme-muted/60">{m.dashboard_waiting_calls()}</span>
                    )}
                  </span>
                </span>
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}
