'use client';

import React from 'react';
import { useImportWizard } from './ImportWizardContext';
import { InspectionResult } from '@/lib/url-inspector';
import { useScoutVersionSelection } from './hooks/useScoutVersionSelection';
import { useScoutTimingDiagnostics } from './hooks/useScoutTimingDiagnostics';
import { DedupNoticeCard } from './scout/DedupNoticeCard';
import { DirectoryConfirmView } from './scout/DirectoryConfirmView';

interface ScoutFeedbackCardProps {
  inspectionResult?: InspectionResult | null;
  scoutError?: {
    status?: string;
    error?: string;
    diagnosticDescription?: string;
    suggestedFormat?: string;
  } | null;
}

/**
 * Scout 结果反馈卡（视图分发层）：
 * - Priority 2：去重/同源警示卡（DedupNoticeCard，存在重复且未关闭警示时独占）
 * - Priority 3：Sub-step 1B 目标目录决策视图（DirectoryConfirmView）
 */
export function ScoutFeedbackCard({ inspectionResult, scoutError }: ScoutFeedbackCardProps) {
  const {
    dedupInfo,
    scoutSameSource,
    parsedUrlInfo,
    importScopeMode,
    setImportScopeMode,
    setStep,
    resetWizard,
    handleScout,
    hasDismissedDedup,
    setHasDismissedDedup,
    scoutData,
    recommendedPrefix,
    selectedPrefix,
    setSelectedPrefix,
    targetLanguage,
    setSubStep,
    subStep,
    loading,
    prefixLoading,
    onConfirmDirectory,
    ackCost,
    setAckCost,
  } = useImportWizard();

  // Version / Cascade Picker & exclusion report hook
  const {
    showAllVersions,
    setShowAllVersions,
    showCascadePicker,
    setShowCascadePicker,
    showExclusionDetails,
    setShowExclusionDetails,
    effectiveExclusionReport,
  } = useScoutVersionSelection({
    scoutData,
    selectedPrefix,
  });

  // Prefix-outline timings & diagnostics copy hook
  const { prefixTimings, formatMs, copyTimings } = useScoutTimingDiagnostics({
    scoutData,
    selectedPrefix,
  });

  // Priority 2: Deduplication & Fork Notice Cards (Only when scout has completed and duplicate exists and warning is not dismissed)
  // Case 3b：同源相似命中（clone/镜像——fork 元数据探测不到的场景；fork 自身由 Case 3 优先展示）
  const effectiveDedup = dedupInfo ?? scoutData?.dedupInfo ?? null;
  const sameSourceVisible =
    scoutSameSource &&
    !effectiveDedup?.existsOnShelf &&
    !effectiveDedup?.existsInExplore &&
    !(effectiveDedup?.isFork && effectiveDedup?.upstream);
  const hasDuplicates = effectiveDedup && (effectiveDedup.existsOnShelf || effectiveDedup.existsInExplore || effectiveDedup.isFork);
  const showDedupCard = (hasDuplicates || sameSourceVisible) && !hasDismissedDedup;

  if (showDedupCard) {
    return (
      <DedupNoticeCard
        dedupInfo={effectiveDedup}
        sameSource={scoutSameSource}
        sameSourceVisible={Boolean(sameSourceVisible)}
        setHasDismissedDedup={setHasDismissedDedup}
        resetWizard={resetWizard}
        handleScout={handleScout}
      />
    );
  }

  // Priority 3: Sub-step 1B Target Directory Decision Gate View
  if (subStep === 'directory_confirm' && scoutData && !loading && (!hasDuplicates || hasDismissedDedup)) {
    return (
      <DirectoryConfirmView
        scoutData={scoutData}
        parsedUrlInfo={parsedUrlInfo}
        importScopeMode={importScopeMode}
        setImportScopeMode={setImportScopeMode}
        selectedPrefix={selectedPrefix}
        recommendedPrefix={recommendedPrefix}
        setSelectedPrefix={setSelectedPrefix}
        targetLanguage={targetLanguage}
        showAllVersions={showAllVersions}
        prefixLoading={prefixLoading}
        setSubStep={setSubStep}
        onConfirmDirectory={onConfirmDirectory}
      />
    );
  }

  return null;
}
