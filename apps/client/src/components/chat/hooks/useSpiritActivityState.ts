'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { InkSpiritState } from '../InkSpiritAvatar';

interface UseSpiritActivityStateOptions {
  isLoading: boolean;
  status: string;
  isChatOpen: boolean;
  isHovered: boolean;
}

export function useSpiritActivityState({
  isLoading,
  status,
  isChatOpen,
  isHovered,
}: UseSpiritActivityStateOptions) {
  const [stateOverride, setStateOverride] = useState<InkSpiritState | null>(null);
  const overrideTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [isFocused, setIsFocused] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [inactiveTime, setInactiveTime] = useState(0);

  const readingTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        setIsFocused(true);
      }
    };
    const handleFocusOut = () => {
      setIsFocused(false);
    };
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);
    return () => {
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      setIsReading(true);
      if (readingTimerRef.current) clearTimeout(readingTimerRef.current);
      readingTimerRef.current = setTimeout(() => {
        setIsReading(false);
      }, 1500);
    };
    window.addEventListener('scroll', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (readingTimerRef.current) clearTimeout(readingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const resetTimer = () => setInactiveTime(0);
    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('click', resetTimer);
    window.addEventListener('scroll', resetTimer);
    window.addEventListener('keydown', resetTimer);

    const timerInterval = setInterval(() => {
      setInactiveTime((prev) => prev + 5);
    }, 5000);

    return () => {
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('click', resetTimer);
      window.removeEventListener('scroll', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      clearInterval(timerInterval);
    };
  }, []);

  const triggerStateOverride = useCallback((newState: InkSpiritState, durationMs: number) => {
    if (overrideTimerRef.current) clearTimeout(overrideTimerRef.current);
    setStateOverride(newState);
    overrideTimerRef.current = setTimeout(() => {
      setStateOverride(null);
      overrideTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (overrideTimerRef.current) {
        clearTimeout(overrideTimerRef.current);
        overrideTimerRef.current = null;
      }
      if (readingTimerRef.current) {
        clearTimeout(readingTimerRef.current);
        readingTimerRef.current = null;
      }
    };
  }, []);

  const spiritState = useMemo<InkSpiritState>(() => {
    if (stateOverride) return stateOverride;
    if (isLoading) {
      return status === 'submitted' ? 'thinking' : 'typing';
    }
    if (isChatOpen) return 'listening';
    if (isHovered) return 'indifferent';
    if (isFocused) return 'focused';
    if (isReading) return 'reading';
    if (inactiveTime >= 600) return 'sleeping';
    if (inactiveTime >= 180) return 'dosing';
    return 'idle';
  }, [stateOverride, isLoading, status, isChatOpen, isHovered, isFocused, isReading, inactiveTime]);

  return {
    spiritState,
    triggerStateOverride,
    isFocused,
    isReading,
    inactiveTime,
  };
}
