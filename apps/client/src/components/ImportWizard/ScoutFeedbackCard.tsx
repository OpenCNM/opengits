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

  const { prefixTimings, formatMs, copyTimings } = useScoutTimingDiagnostics({
    scoutData,
    selectedPrefix,
  });

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
