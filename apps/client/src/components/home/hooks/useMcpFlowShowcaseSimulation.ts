'use client';

import { useState, useEffect, useRef } from 'react';
import { useInView } from 'framer-motion';
import { getRepoStories, type RepoStoryData } from '../data/mcpShowcaseData';

export function useMcpFlowShowcaseSimulation() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(containerRef, { amount: 0.15, once: false });

  const [repoIndex, setRepoIndex] = useState<number>(0);
  const [layoutSeed, setLayoutSeed] = useState<number>(0);
  const [stage, setStage] = useState<1 | 2 | 3 | 4>(1);
  const [typedUrl, setTypedUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const stories = getRepoStories();
  const currentData: RepoStoryData = stories[repoIndex] ?? stories[0];

  // Stage Timeline Loop Engine: Restarts freshly from Step 1 whenever scrolled into view
  useEffect(() => {
    if (!isInView) {
      setStage(1);
      setTypedUrl('');
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0;
      }
      return;
    }

    setStage(1);
    setTypedUrl('');
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    const targetUrl = currentData.repoUrl;
    let charIdx = 0;

    const initialDelayTimer = setTimeout(() => {
      const typingInterval = setInterval(() => {
        if (charIdx <= targetUrl.length) {
          setTypedUrl(targetUrl.slice(0, charIdx));
          charIdx++;
        } else {
          clearInterval(typingInterval);
        }
      }, 32);
    }, 200);

    const stage2Timer = setTimeout(() => {
      setStage(2);
    }, 1800);

    const stage3Timer = setTimeout(() => {
      setStage(3);
    }, 3800);

    const stage4Timer = setTimeout(() => {
      setStage(4);
    }, 6000);

    const nextLoopTimer = setTimeout(() => {
      setRepoIndex((prev) => (prev + 1) % stories.length);
      setLayoutSeed((prev) => (prev + 1) % 4);
    }, 8200);

    return () => {
      clearTimeout(initialDelayTimer);
      clearTimeout(stage2Timer);
      clearTimeout(stage3Timer);
      clearTimeout(stage4Timer);
      clearTimeout(nextLoopTimer);
    };
  }, [isInView, repoIndex, currentData.repoUrl]);

  const handleStageSelect = (targetStage: 1 | 2 | 3 | 4) => {
    setStage(targetStage);
    if (targetStage === 1) {
      setTypedUrl('');
      const targetUrl = currentData.repoUrl;
      let charIdx = 0;
      const interval = setInterval(() => {
        if (charIdx <= targetUrl.length) {
          setTypedUrl(targetUrl.slice(0, charIdx));
          charIdx++;
        } else {
          clearInterval(interval);
        }
      }, 32);
    } else {
      setTypedUrl(currentData.repoUrl);
    }
  };

  const handleCopyCommand = () => {
    navigator.clipboard.writeText('npx @opengits/mcp-server');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return {
    containerRef,
    scrollContainerRef,
    repoIndex,
    setRepoIndex,
    layoutSeed,
    setLayoutSeed,
    stage,
    setStage,
    typedUrl,
    copied,
    currentData,
    handleStageSelect,
    handleCopyCommand,
  };
}
