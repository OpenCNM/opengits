'use client';

import { useMemo } from 'react';
import * as m from '@/paraglide/messages';
import {
  AXES_ORDER,
  getAxisConfig,
  type RadarAxis,
} from '../utils/radarGeometry';

export interface UseRadarProfileProps {
  reviewPipeline: {
    total?: number;
    dimensions?: Array<{ key: string; label: string; score: number; detail?: string }>;
  } | null;
  reviewLlm: {
    overallScore?: number;
    archetype?: string;
    coreHighlight?: string;
    targetAudience?: string;
    summary?: string;
    unavailable?: boolean;
    dimensions?: Array<{ name: string; score: number; comment?: string }>;
  } | null;
  recScore?: number;
}

export function buildRadarAxes(
  _reviewPipeline: UseRadarProfileProps['reviewPipeline'],
  reviewLlm: UseRadarProfileProps['reviewLlm']
): RadarAxis[] {
  const lDims = reviewLlm?.dimensions || [];
  const axisConfig = getAxisConfig();

  const pickLlm = (keys: string[]): { score: number; comment?: string } | null => {
    for (const k of keys) {
      const d = lDims.find((x) => x.name === k);
      if (d && typeof d.score === 'number') {
        const raw = d.score;
        const norm = raw <= 10 && raw > 0 ? Math.round(raw * 10) : raw;
        return { score: norm, comment: d.comment };
      }
    }
    return null;
  };

  const rawAi = reviewLlm?.unavailable ? null : reviewLlm?.overallScore;
  const aiScore =
    rawAi != null ? (rawAi <= 10 && rawAi > 0 ? Math.round(rawAi * 10) : rawAi) : null;

  const llmDepth = pickLlm(['depth', 'architecture', 'content_quality']);
  const depthVal = llmDepth?.score ?? aiScore ?? null;
  const depthComment = llmDepth?.comment || axisConfig.depth.description;

  const llmCodeFidelity = pickLlm(['codeFidelity', 'code_fidelity', 'practicality', 'code_quality']);
  const codeFidelityVal = llmCodeFidelity?.score ?? aiScore ?? null;
  const codeFidelityComment = llmCodeFidelity?.comment || axisConfig.codeFidelity.description;

  const llmPedagogy = pickLlm(['pedagogy', 'clarity', 'coherence']);
  const pedagogyVal = llmPedagogy?.score ?? aiScore ?? null;
  const pedagogyComment = llmPedagogy?.comment || axisConfig.pedagogy.description;

  const llmCoverage = pickLlm(['coverage', 'breadth', 'completeness']);
  const coverageVal = llmCoverage?.score ?? aiScore ?? null;
  const coverageComment = llmCoverage?.comment || axisConfig.coverage.description;

  return AXES_ORDER.map((key) => {
    let val: number | null = null;
    let comment: string = axisConfig[key].description;

    if (key === 'depth') {
      val = depthVal;
      comment = depthComment;
    } else if (key === 'codeFidelity') {
      val = codeFidelityVal;
      comment = codeFidelityComment;
    } else if (key === 'pedagogy') {
      val = pedagogyVal;
      comment = pedagogyComment;
    } else if (key === 'coverage') {
      val = coverageVal;
      comment = coverageComment;
    }

    return {
      key,
      label: axisConfig[key].label,
      description: axisConfig[key].description,
      comment,
      direction: axisConfig[key].direction,
      value: val != null ? Math.min(100, Math.max(0, Math.round(val))) : null,
    };
  });
}

export function getPedagogicalArchetype(
  axes: RadarAxis[],
  llmArchetype?: string
): { label: string; desc: string; key: string } {
  if (llmArchetype === 'CODE_DIVER') {
    return { key: 'CODE_DIVER', label: m.radar_archetype_code_diver(), desc: m.radar_archetype_code_diver_desc() };
  }
  if (llmArchetype === 'SYSTEM_ARCHITECT' || llmArchetype === 'ARCHITECTURE') {
    return { key: 'SYSTEM_ARCHITECT', label: m.radar_archetype_system_architect(), desc: m.radar_archetype_system_architect_desc() };
  }
  if (llmArchetype === 'HOLISTIC_PRIMER' || llmArchetype === 'COMPREHENSIVE' || llmArchetype === 'TUTORIAL') {
    return { key: 'HOLISTIC_PRIMER', label: m.radar_archetype_holistic_primer(), desc: m.radar_archetype_holistic_primer_desc() };
  }
  if (llmArchetype === 'FOCUSED_CORE' || llmArchetype === 'PRACTICAL' || llmArchetype === 'PRODUCTION') {
    return { key: 'FOCUSED_CORE', label: m.radar_archetype_focused_core(), desc: m.radar_archetype_focused_core_desc() };
  }
  if (llmArchetype === 'BALANCED') {
    return { key: 'BALANCED', label: m.radar_archetype_balanced(), desc: m.radar_archetype_balanced_desc() };
  }

  const depth = axes.find((a) => a.key === 'depth')?.value ?? 75;
  const code = axes.find((a) => a.key === 'codeFidelity')?.value ?? 75;
  const pedagogy = axes.find((a) => a.key === 'pedagogy')?.value ?? 75;
  const coverage = axes.find((a) => a.key === 'coverage')?.value ?? 75;

  const dx = code - coverage;
  const dy = depth - pedagogy;

  if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) {
    return { key: 'BALANCED', label: m.radar_archetype_balanced(), desc: m.radar_archetype_balanced_desc() };
  }

  if (dy >= 0 && dx >= 0) {
    return { key: 'CODE_DIVER', label: m.radar_archetype_code_diver(), desc: m.radar_archetype_code_diver_desc() };
  }
  if (dy >= 0 && dx < 0) {
    return { key: 'SYSTEM_ARCHITECT', label: m.radar_archetype_system_architect(), desc: m.radar_archetype_system_architect_desc() };
  }
  if (dy < 0 && dx < 0) {
    return { key: 'HOLISTIC_PRIMER', label: m.radar_archetype_holistic_primer(), desc: m.radar_archetype_holistic_primer_desc() };
  }
  return { key: 'FOCUSED_CORE', label: m.radar_archetype_focused_core(), desc: m.radar_archetype_focused_core_desc() };
}

export function useRadarProfile({
  reviewPipeline,
  reviewLlm,
}: UseRadarProfileProps) {
  const hasScores =
    !!reviewLlm &&
    !reviewLlm.unavailable &&
    (
      (Array.isArray(reviewLlm.dimensions) && reviewLlm.dimensions.length > 0) ||
      (typeof reviewLlm.overallScore === 'number' && reviewLlm.overallScore > 0)
    );

  const axes = useMemo(
    () => (hasScores ? buildRadarAxes(reviewPipeline, reviewLlm) : []),
    [hasScores, reviewPipeline, reviewLlm]
  );

  const archetype = useMemo(
    () => getPedagogicalArchetype(axes, reviewLlm?.archetype),
    [axes, reviewLlm?.archetype]
  );

  return {
    hasScores,
    axes,
    archetype,
  };
}
