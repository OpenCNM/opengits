'use client';

import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

interface UseScoutTimingDiagnosticsOptions {
  scoutData: any;
  selectedPrefix: string;
}

export function useScoutTimingDiagnostics({
  scoutData,
  selectedPrefix,
}: UseScoutTimingDiagnosticsOptions) {
  const prefixTimings = (scoutData?.prefixTimings?.[selectedPrefix] ?? null) as any;

  const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

  const buildTimingsText = (t: any) => {
    const ownerRepo = scoutData ? `${scoutData.owner}/${scoutData.repo}` : '';
    const archStr =
      t.meta?.archiveFromCache === null
        ? m.timing_diag_no_archive()
        : t.meta?.archiveFromCache
        ? m.timing_diag_disk_hit()
        : m.timing_diag_first_download();
    const llmStr = t.meta?.llmCacheHit
      ? m.outline_draft_timing_cache_hit()
      : t.meta?.llmRan
      ? m.timing_diag_llm_ran({ count: t.llmCalls?.length || 0 })
      : m.timing_diag_llm_not_ran();
    const callsStr = (t.llmCalls || [])
      .map(
        (c: any, i: number) =>
          `#${i + 1} ${formatMs(c.durationMs)} · ${c.promptTokens}→${c.completionTokens} tok [attempt${
            c.attempt
          } ${c.stream ? 'stream' : 'nostream'}]`
      )
      .join(' | ');

    return [
      m.timing_diag_header({ repo: ownerRepo, prefix: selectedPrefix || '/' }),
      m.timing_diag_summary({
        duration: formatMs(t.totalMs),
        files: t.meta?.fileCount ?? 0,
        arch: archStr,
        llm: llmStr,
      }),
      m.timing_diag_phases({
        tree: formatMs(t.phases?.treeFetchMs ?? 0),
        arch: formatMs(t.phases?.archivePrepMs ?? 0),
        title: formatMs(t.phases?.titleMiningMs ?? 0),
        llm: formatMs(t.phases?.llmOutlineMs ?? 0),
        fallback: formatMs(t.phases?.ruleFallbackMs ?? 0),
      }),
      callsStr ? m.timing_diag_llm_calls({ calls: callsStr }) : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const copyTimings = () => {
    if (!prefixTimings) return;
    navigator.clipboard
      .writeText(buildTimingsText(prefixTimings))
      .then(() => {
        toastManager.add({
          type: 'success',
          title: m.common_copied(),
          description: m.scout_diagnostics_copied_desc(),
        });
      })
      .catch(() => {
        toastManager.add({
          type: 'error',
          title: m.toast_action_failed(),
          description: m.toast_copy_manual_hint(),
        });
      });
  };

  return {
    prefixTimings,
    formatMs,
    buildTimingsText,
    copyTimings,
  };
}
