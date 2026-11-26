'use client';

import React from 'react';
import { ExternalLink, Star, Eye } from 'lucide-react';
import { PreviewCard, PreviewCardTrigger, PreviewCardPopup } from '@/components/ui/preview-card';
import { ENGINE_CONFIG } from '@/lib/config';
import { WEB_DOC_PREFIX } from '@/lib/constants';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { formatCompactTokens } from '@/lib/format';
import * as m from '@/paraglide/messages';

export interface RepoGithubOriginPopoverProps {
  repo: {
    owner: string;
    repo: string;
    description?: string;
    starCount?: number;
    gitSha?: string | null;
    importedSha?: string | null;
    branch?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
    license?: string;
    repoProfile?: any;
    [key: string]: any;
  };
  className?: string;
}

export function GithubIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function formatDate(dateValue?: Date | string | null): string {
  if (!dateValue) return '—';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

export function RepoGithubOriginPopover({ repo, className = '' }: RepoGithubOriginPopoverProps) {
  const isWebDoc = isWebDocRepository(repo);
  const cleanTitle = resolveRepositoryDisplayName(repo);

  const originUrl = isWebDoc
    ? (repo.repoProfile?.originalUrl || `https://${repo.repo.replace(new RegExp(`^${WEB_DOC_PREFIX}`), '')}`)
    : `https://github.com/${repo.owner}/${repo.repo}`;

  if (isWebDoc) {
    let hostname = '';
    try {
      hostname = new URL(originUrl).hostname;
    } catch {
      hostname = repo.repo;
    }

    const pageCount = repo.repoProfile?.pageCount || repo.processedDocsCount || repo.chapterCount || '—';
    const engineText = repo.repoProfile?.engineUsed === 'fast-path' ? m.github_origin_engine_fast_path() : repo.repoProfile?.engineUsed || m.github_origin_engine_smart();

    return (
      <PreviewCard>
        <PreviewCardTrigger
          className={`inline-flex items-center justify-center p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface-variant transition-colors cursor-pointer shrink-0 ${className}`}
          aria-label={m.tutorial_preview_title()}
          title={m.tutorial_preview_title()}
        >
          <Eye className="w-3.5 h-3.5 opacity-70 hover:opacity-100" />
        </PreviewCardTrigger>
        <PreviewCardPopup
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="w-84 sm:w-96 p-3.5 rounded-xl border border-theme-border bg-theme-surface text-theme-foreground shadow-xl z-50 text-xs font-sans flex flex-col space-y-3"
        >
          <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-theme-border/60">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-1 rounded-md bg-sky-500/10 text-sky-500 shrink-0">
                <ExternalLink className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="font-semibold text-theme-foreground truncate block text-sm">
                  {cleanTitle}
                </span>
                <span className="text-xs text-theme-muted font-mono block truncate">
                  {hostname}
                </span>
              </div>
            </div>
            <a
              href={originUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 p-1.5 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-bg border border-theme-border/60 transition-colors"
              title={m.github_origin_open_original_site()}
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          {repo.description && (
            <p className="text-xs text-theme-muted leading-relaxed line-clamp-3">
              {repo.description}
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-theme-bg/60 p-2.5 rounded-lg border border-theme-border/40">
            {repo.transcriptionTokens && repo.transcriptionTokens > 0 ? (
              <div className="min-w-0">
                <span className="text-theme-muted text-micro block whitespace-nowrap">{m.tutorial_transcription_tokens_label()}</span>
                <span className="font-semibold text-theme-foreground block mt-0.5 text-xs">
                  {formatCompactTokens(repo.transcriptionTokens)} Token
                </span>
              </div>
            ) : null}
            <div className="min-w-0">
              <span className="text-theme-muted text-micro block whitespace-nowrap">{m.github_origin_docs_label()}</span>
              <span className="font-semibold text-theme-foreground block mt-0.5 text-xs">
                {m.github_origin_docs_count({ count: pageCount })}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-theme-muted text-micro block whitespace-nowrap">{m.github_origin_engine_label()}</span>
              <span className="font-medium text-theme-foreground truncate block mt-0.5 text-xs" title={engineText}>
                {engineText}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-theme-muted text-micro block whitespace-nowrap">{m.github_origin_last_synced()}</span>
              <span className="text-theme-foreground/90 block mt-0.5 whitespace-nowrap text-xs">
                {formatDate(repo.updatedAt || repo.createdAt)}
              </span>
            </div>
          </div>
        </PreviewCardPopup>
      </PreviewCard>
    );
  }

  const commitSha = repo.gitSha || repo.importedSha;
  const targetBranch = repo.branch || ENGINE_CONFIG.defaultBranch;
  const rawStars =
    repo.starCount ??
    repo.stargazersCount ??
    repo.stargazers_count ??
    repo.repoProfile?.starCount ??
    repo.repoProfile?.stargazersCount ??
    repo.repoProfile?.stars ??
    repo.repoProfile?.stargazers_count;

  return (
    <PreviewCard>
      <PreviewCardTrigger
        className={`inline-flex items-center justify-center p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface-variant transition-colors cursor-pointer shrink-0 ${className}`}
        aria-label={m.tutorial_preview_title()}
        title={m.tutorial_preview_title()}
      >
        <Eye className="w-3.5 h-3.5 opacity-70 hover:opacity-100" />
      </PreviewCardTrigger>
      <PreviewCardPopup
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-84 sm:w-96 p-3.5 rounded-xl border border-theme-border bg-theme-surface text-theme-foreground shadow-xl z-50 text-xs font-sans flex flex-col space-y-3"
      >
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-theme-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <GithubIcon className="w-4 h-4 text-theme-foreground shrink-0" />
            <div className="min-w-0">
              <a
                href={originUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono font-semibold text-theme-foreground hover:text-theme-primary transition-colors truncate block text-sm"
              >
                {repo.owner}/{repo.repo}
              </a>
              <span className="text-xs text-theme-muted font-mono block truncate">
                github.com/{repo.owner}/{repo.repo}
              </span>
            </div>
          </div>
          <a
            href={originUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 p-1.5 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-bg border border-theme-border/60 transition-colors"
            title={m.github_origin_open_github_repo()}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>

        {repo.description && (
          <p className="text-xs text-theme-muted leading-relaxed line-clamp-3">
            {repo.description}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-theme-bg/60 p-2.5 rounded-lg border border-theme-border/40">
          {repo.transcriptionTokens && repo.transcriptionTokens > 0 ? (
            <div className="min-w-0">
              <span className="text-theme-muted text-micro block whitespace-nowrap">{m.tutorial_transcription_tokens_label()}</span>
              <span className="font-semibold text-theme-foreground block mt-0.5 text-xs">
                {formatCompactTokens(repo.transcriptionTokens)} Token
              </span>
            </div>
          ) : null}
          {repo.transcriptionModels && repo.transcriptionModels.length > 0 ? (
            <div className="min-w-0">
              <span className="text-theme-muted text-micro block whitespace-nowrap">{m.onboarding_model()}</span>
              <span className="font-semibold text-theme-foreground truncate block mt-0.5 text-xs" title={repo.transcriptionModels.join(', ')}>
                {repo.transcriptionModels.join(', ')}
              </span>
            </div>
          ) : null}
          <div className="min-w-0">
            <span className="text-theme-muted text-micro block whitespace-nowrap">{m.github_origin_docs_label()}</span>
            <span className="font-semibold text-theme-foreground block mt-0.5 text-xs">
              {m.github_origin_docs_count({ count: repo.processedDocsCount || repo.chapterCount || '—' })}
            </span>
          </div>
          <div className="min-w-0">
            <span className="text-theme-muted text-micro block whitespace-nowrap">{m.github_origin_last_synced()}</span>
            <span className="text-theme-foreground/90 block mt-0.5 whitespace-nowrap text-xs">
              {formatDate(repo.updatedAt || repo.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between text-micro text-theme-muted font-mono pt-1 border-t border-theme-border/40">
          <span className="flex items-center gap-1">
            <Star className="w-3.5 h-3.5 text-theme-muted shrink-0" />
            <span>{typeof rawStars === 'number' ? rawStars.toLocaleString() : '—'}</span>
          </span>
          <span className="truncate" title={`${targetBranch}${commitSha ? ` @ ${commitSha}` : ''}`}>
            {targetBranch} {commitSha ? `@ ${commitSha.slice(0, 7)}` : ''}
          </span>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
