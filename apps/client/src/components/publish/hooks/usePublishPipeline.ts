'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';

export type Stage =
  | 'dedup'
  | 'transcription'
  | 'quality'
  | 'mutate'
  | 'complete'
  | 'submitted'
  | 'failed';

export function getPublishStages(): Array<{
  id: Exclude<Stage, 'complete' | 'failed'>;
  step: string;
  label: string;
  desc: string;
}> {
  return [
    {
      id: 'dedup',
      step: 'I',
      label: m.publish_stage_dedup_label(),
      desc: m.publish_stage_dedup_desc(),
    },
    {
      id: 'transcription',
      step: 'II',
      label: m.publish_stage_transcription_label(),
      desc: m.publish_stage_transcription_desc(),
    },
    {
      id: 'quality',
      step: 'III',
      label: m.publish_stage_quality_label(),
      desc: m.publish_stage_quality_desc(),
    },
    {
      id: 'mutate',
      step: 'IV',
      label: m.publish_stage_mutate_label(),
      desc: m.publish_stage_mutate_desc(),
    },
  ];
}

export const STAGE_ORDER: Stage[] = ['dedup', 'transcription', 'quality', 'mutate', 'complete'];

interface UsePublishPipelineOptions {
  isOpen: boolean;
  owner: string;
  repo: string;
  repoId?: string;
  relayEnabled?: boolean;
  onSuccess?: () => void;
  onSubmitted?: () => void;
}

export function usePublishPipeline({
  isOpen,
  owner,
  repo,
  repoId,
  relayEnabled,
  onSuccess,
  onSubmitted,
}: UsePublishPipelineOptions) {
  const [currentStage, setCurrentStage] = useState<Stage>('dedup');
  const [failedStage, setFailedStage] = useState<Stage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [publishScores, setPublishScores] = useState<{ pipeline: number; llm: number } | null>(
    null
  );

  // Stable refs for callbacks to prevent useEffect re-triggering loops
  const onSuccessRef = useRef(onSuccess);
  const onSubmittedRef = useRef(onSubmitted);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onSubmittedRef.current = onSubmitted;
  });

  useEffect(() => {
    if (!isOpen) return;

    // Reset state on open
    setCurrentStage('dedup');
    setFailedStage(null);
    setErrorMessage(null);

    let isSubscribed = true;

    const runPublishPipeline = async () => {
      try {
        setCurrentStage('dedup');

        // 发起真实发布与质检请求
        const publishPromise = api.patch<{
          submitted?: boolean;
          scores?: { pipeline: number; llm: number } | null;
        }>(
          '/api/repos/publish',
          { repoId, owner, repo, relayEnabled },
          { onUnauthorized: 'throw' }
        );

        // 真实请求在后台并发执行，同时通过轻量微任务推进前置校验态展示
        const data = await publishPromise;

        if (!isSubscribed) return;

        // 成功流：快速优雅级联打勾点亮各个安全门
        setCurrentStage('transcription');
        await new Promise((r) => setTimeout(r, 120));
        if (!isSubscribed) return;

        setCurrentStage('quality');
        await new Promise((r) => setTimeout(r, 120));
        if (!isSubscribed) return;

        setCurrentStage('mutate');
        await new Promise((r) => setTimeout(r, 150));
        if (!isSubscribed) return;

        // 安全门模型：通过安全门即公开（complete）；LLM 安全拦截进人工复核（submitted）
        if (data.submitted) {
          setCurrentStage('submitted');
          if (onSubmittedRef.current) onSubmittedRef.current();
        } else {
          setCurrentStage('complete');
          setPublishScores(data.scores || null);
          if (onSuccessRef.current) onSuccessRef.current();
        }
      } catch (err: any) {
        if (!isSubscribed) return;

        // 精准依据服务端返回的 ApiError code 归因具体受阻的阶段
        const errorCode = err?.data?.code || err?.code || '';
        let failureStage: Stage = 'mutate';

        if (errorCode === 'DUPLICATE_EXPLORE') {
          failureStage = 'dedup';
        } else if (errorCode === 'INCOMPLETE_TRANSCRIPTION' || errorCode === 'NO_LICENSE') {
          failureStage = 'transcription';
        } else if (errorCode === 'INVALID_CONTENT') {
          failureStage = 'quality';
        } else {
          failureStage = 'mutate';
        }

        setFailedStage(failureStage);
        setCurrentStage('failed');
        setErrorMessage(err?.message || m.toast_action_failed());
      }
    };

    runPublishPipeline();

    return () => {
      isSubscribed = false;
    };
  }, [isOpen, owner, repo, repoId, relayEnabled]);

  const currentStepIdx = STAGE_ORDER.indexOf(currentStage);

  const subtitleText = (() => {
    if (currentStage === 'complete') return m.publish_success_desc();
    if (currentStage === 'submitted') return m.publish_review_submitted_desc();
    if (currentStage === 'failed') return m.status_failed();
    if (currentStage === 'dedup') return m.publish_stage_dedup_desc();
    if (currentStage === 'transcription') return m.publish_stage_transcription_desc();
    if (currentStage === 'quality') return m.publish_stage_quality_desc();
    if (currentStage === 'mutate') return m.publish_stage_mutate_desc();
    return m.status_processing();
  })();

  return {
    currentStage,
    failedStage,
    errorMessage,
    publishScores,
    currentStepIdx,
    subtitleText,
  };
}
