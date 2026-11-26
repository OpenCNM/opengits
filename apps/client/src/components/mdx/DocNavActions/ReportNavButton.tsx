'use client';
import * as m from '@/paraglide/messages';

import { useReportModal } from '../hooks/useReportModal';

const REPORT_REASONS = [
  { value: 'INFRINGEMENT', labelKey: 'infringement' },
  { value: 'LOW_QUALITY', labelKey: 'lowQuality' },
  { value: 'MALICIOUS', labelKey: 'malicious' },
  { value: 'OTHER', labelKey: 'other' },
] as const;

export function ReportNavButton({
  owner,
  repo,
  repoId,
}: {
  owner: string;
  repo: string;
  repoId?: string;
}) {
  const { reason, setReason, detail, setDetail, open, setOpen, submitting, submit } =
    useReportModal({ owner, repo, repoId });

  const reasonLabels: Record<(typeof REPORT_REASONS)[number]['labelKey'], string> = {
    infringement: m.reader_report_reason_infringement(),
    lowQuality: m.reader_report_reason_low_quality(),
    malicious: m.reader_report_reason_malicious(),
    other: m.reader_report_reason_other(),
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface border border-transparent hover:border-theme-border transition-all text-xs font-serif shrink-0"
        title={m.reader_report_button_title()}
      >
        {m.reader_report()}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-theme-foreground/40 backdrop-blur-xs">
          <div className="bg-theme-bg border border-theme-border rounded-xl shadow-xl w-full max-w-sm overflow-hidden font-sans">
            <div className="p-4 border-b border-theme-border">
              <h3 className="font-serif text-sm font-bold text-theme-foreground">
                {m.reader_report_title({ owner, repo })}
              </h3>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 gap-1.5 text-xs">
                {REPORT_REASONS.map(({ value, labelKey }) => (
                  <label key={value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="report-reason"
                      value={value}
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    <span className="text-theme-foreground">{reasonLabels[labelKey]}</span>
                  </label>
                ))}
              </div>
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder={m.reader_report_detail_placeholder()}
                className="w-full rounded-lg border border-theme-border bg-theme-surface p-2 text-xs text-theme-foreground outline-none focus:border-theme-primary"
              />
            </div>
            <div className="p-4 border-t border-theme-border flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded border border-theme-border text-theme-muted hover:text-theme-foreground text-xs cursor-pointer"
              >
                {m.common_cancel()}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="px-4 py-1.5 rounded bg-theme-primary text-theme-primary-fg hover:opacity-90 transition-opacity text-xs font-bold cursor-pointer disabled:opacity-50"
              >
                {submitting ? m.reader_report_submitting() : m.reader_report_submit()}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
