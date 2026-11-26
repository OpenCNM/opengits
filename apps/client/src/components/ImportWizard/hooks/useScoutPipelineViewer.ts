'use client';

import { useState, useEffect } from 'react';
import * as m from '@/paraglide/messages';

export interface PipelineStageConfig {
  stage: string;
  defaultTitle: string;
  loadingDesc: string;
}

export function getScoutPipelineStages(): PipelineStageConfig[] {
  return [
    {
      stage: 'meta',
      defaultTitle: m.import_scout_repo_info(),
      loadingDesc: m.scout_stage_meta_desc(),
    },
    {
      stage: 'dedup',
      defaultTitle: m.import_scout_smart_locate(),
      loadingDesc: m.scout_stage_dedup_desc(),
    },
    {
      stage: 'tree',
      defaultTitle: m.import_scout_file_structure(),
      loadingDesc: m.scout_stage_tree_desc(),
    },
  ];
}

export interface ScoutStepEvent {
  stage: string;
  tag: string;
  title: string;
  detail: string;
}

export function useScoutPipelineProgression(loading: boolean, scoutSteps: ScoutStepEvent[]) {
  const [displayedCount, setDisplayedCount] = useState(0);
  const targetCompletedCount = scoutSteps.length;
  const stages = getScoutPipelineStages();

  useEffect(() => {
    if (loading && scoutSteps.length === 0) {
      setDisplayedCount(0);
    }
  }, [loading, scoutSteps.length]);

  useEffect(() => {
    if (!loading) {
      setDisplayedCount(targetCompletedCount);
      return;
    }

    if (displayedCount < targetCompletedCount) {
      const timer = setTimeout(() => {
        setDisplayedCount((prev) => Math.min(prev + 1, targetCompletedCount));
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [displayedCount, targetCompletedCount, loading]);

  const activeIdx = Math.min(displayedCount, stages.length - 1);

  const stageStates = stages.map((stageConfig, idx) => {
    const isCompleted = idx < activeIdx;
    const isActive = idx === activeIdx;

    const stageEvents = scoutSteps.filter((s) => s.stage === stageConfig.stage);
    const latestEvent = stageEvents[stageEvents.length - 1];

    let title = stageConfig.defaultTitle;
    let detail = stageConfig.loadingDesc;

    if (isCompleted) {
      title = latestEvent?.title || stageConfig.defaultTitle;
      detail = latestEvent?.detail || m.status_completed();
    } else if (isActive) {
      title = latestEvent?.title || stageConfig.defaultTitle;
      detail = latestEvent?.detail || stageConfig.loadingDesc;
    }

    return {
      stageConfig,
      idx,
      isCompleted,
      isActive,
      title,
      detail,
    };
  });

  return {
    displayedCount,
    activeIdx,
    stages,
    stageStates,
  };
}
