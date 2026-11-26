'use client';

import { useState, useMemo } from 'react';

interface UseScoutVersionSelectionOptions {
  scoutData: any;
  selectedPrefix: string;
}

export function deriveScopedExclusionReport(rawReport: any, selectedPrefix: string) {
  if (!rawReport) return null;

  const detailFiles = rawReport.allExcludedFiles || rawReport.sampleExcludedFiles || [];
  const prefixToMatch = selectedPrefix
    ? selectedPrefix.endsWith('/')
      ? selectedPrefix
      : selectedPrefix + '/'
    : '';

  if (!prefixToMatch) {
    return {
      totalExcludedCount: rawReport.totalExcludedCount ?? detailFiles.length,
      byCategory: rawReport.byCategory ?? {},
      sampleExcludedFiles: (rawReport.sampleExcludedFiles || detailFiles).slice(0, 15),
      allExcludedFiles: detailFiles,
    };
  }

  const scopedFiles = detailFiles.filter(
    (f: any) =>
      f.path.startsWith(prefixToMatch) ||
      f.path === selectedPrefix.replace(/\/$/, '')
  );

  const byCategory: Record<string, number> = {
    archive: 0,
    executable: 0,
    office_media: 0,
    build_db: 0,
    oversized: 0,
  };
  scopedFiles.forEach((f: any) => {
    if (f.category && byCategory[f.category] !== undefined) {
      byCategory[f.category]++;
    } else if (f.category) {
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }
  });

  return {
    totalExcludedCount: scopedFiles.length,
    byCategory,
    sampleExcludedFiles: scopedFiles.slice(0, 15),
    allExcludedFiles: scopedFiles,
  };
}

export function useScoutVersionSelection({
  scoutData,
  selectedPrefix,
}: UseScoutVersionSelectionOptions) {
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [showCascadePicker, setShowCascadePicker] = useState(true);
  const [showExclusionDetails, setShowExclusionDetails] = useState(false);

  const effectiveExclusionReport = useMemo(
    () => deriveScopedExclusionReport(scoutData?.exclusionReport, selectedPrefix),
    [scoutData?.exclusionReport, selectedPrefix]
  );

  return {
    showAllVersions,
    setShowAllVersions,
    showCascadePicker,
    setShowCascadePicker,
    showExclusionDetails,
    setShowExclusionDetails,
    effectiveExclusionReport,
  };
}
