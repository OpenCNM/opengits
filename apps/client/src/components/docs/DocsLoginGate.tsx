'use client';

// 文档登录门槛（统一登录引导页）：/docs 全量要求登录，匿名访客在此止步。
// 所有人看到同一页面：书籍信息 + 烘焙进度 + 登录 CTA（callbackUrl 回跳当前页）。

import { usePathname } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { RelayAvatarStack } from '@/components/update/RelayAvatarStack';
import type { RelayParticipant } from '@/components/update/RelayAvatarStack';

import * as m from '@/paraglide/messages';

export interface DocsLoginGateProps {
  owner: string;
  repo: string;
  title: string;
  chapterCount: number;
  bakedCount: number;
  /** 接力进行中数量与参与者（未开启接力的仓为空） */
  relayInProgress?: number;
  relayParticipants?: RelayParticipant[];
}

export function DocsLoginGate({
  owner,
  repo,
  title,
  chapterCount,
  bakedCount,
  relayInProgress = 0,
  relayParticipants = [],
}: DocsLoginGateProps) {
  const pathname = usePathname();
  const progressPercent = chapterCount > 0 ? Math.min(100, Math.round((bakedCount / chapterCount) * 100)) : 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-theme-bg px-4 py-12 text-center font-sans">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border border-theme-border/70 bg-theme-surface/60 p-8 shadow-2xs">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-theme-primary/30 bg-theme-primary/[0.08] text-theme-primary text-xs font-bold">
          <BookOpen className="w-3.5 h-3.5" />
          {m.auth_login_to_read()}
        </span>

        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-lg font-bold text-theme-foreground">{title}</h1>
          <p className="font-mono text-xs text-theme-muted">
            {owner}/{repo}
          </p>
        </div>

        <div className="w-full flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-theme-muted">
            <span>
              {m.docs_gate_baked_progress({ baked: bakedCount, total: chapterCount })}
            </span>
            <span className="font-mono">{progressPercent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-theme-border/60 overflow-hidden">
            <div className="h-full rounded-full bg-theme-primary/70" style={{ width: `${progressPercent}%` }} />
          </div>
          {relayParticipants.length > 0 && (
            <div className="flex items-center justify-between pt-1">
              <RelayAvatarStack participants={relayParticipants} size="xs" />
              {relayInProgress > 0 && (
                <span className="text-micro text-theme-muted">
                  {m.docs_gate_relay_in_progress({ count: relayInProgress })}
                  <span className="ml-1 inline-block w-1 h-1 rounded-full bg-theme-primary animate-pulse align-middle" />
                </span>
              )}
            </div>
          )}
        </div>

        <p className="text-xs leading-relaxed text-theme-muted">
          {m.docs_gate_description()}
        </p>

        <a
          href={`/auth/signin?callbackUrl=${encodeURIComponent(pathname || '/')}`}
          className="group inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-theme-primary px-5 py-3 text-theme-primary-fg text-xs font-bold transition-all hover:scale-[1.02] hover:opacity-90 hover:shadow-lg active:scale-[0.98] cursor-pointer"
        >
          <GithubIcon className="w-4 h-4 transition-transform group-hover:rotate-6" />
          {m.auth_login_with_github()}
        </a>
      </div>
    </div>
  );
}
