'use client';

import React, { useEffect } from 'react';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { useAITelemetry } from '@/hooks/useAITelemetry';

export function AITelemetryProvider({ children }: { children: React.ReactNode }) {
 useAITelemetry();

 useEffect(() => {
 const handleCopy = (e: ClipboardEvent) => {
 const selection = window.getSelection();
 if (!selection || selection.toString().length === 0) return;

 const target = (e.target instanceof HTMLElement ? e.target : selection.anchorNode?.parentElement) as HTMLElement | null;
 if (!target) return;

 if (target.closest('pre') || target.closest('code') || target.closest('[data-telemetry-event="CODE_COPY"]')) {
 trackEvent({
 eventType: TELEMETRY_EVENTS.CODE_COPY,
 metadata: { length: selection.toString().length }
 });
 }
 };

 let clickCount = 0;
 let clickTimer: NodeJS.Timeout | null = null;

 const handleClick = (e: MouseEvent) => {
 const target = (e.target instanceof HTMLElement ? e.target : (e.target as Node)?.parentElement)?.closest('[data-telemetry-event]') as HTMLElement | null;
 if (target) {
 const eventType = target.dataset.telemetryEvent;
 if (eventType) {
 const payloadStr = target.dataset.telemetryPayload;
 const metadata = payloadStr ? JSON.parse(payloadStr) : undefined;
 trackEvent({ eventType, targetId: target.id, metadata });
 }
 }

 clickCount++;
 if (clickCount >= 5) {
 const rageTarget = e.target instanceof HTMLElement ? e.target : (e.target as Node)?.parentElement as HTMLElement;
 trackEvent({
 eventType: TELEMETRY_EVENTS.RAGE_CLICK,
 targetId: rageTarget?.id || rageTarget?.tagName || 'UNKNOWN'
 });
 clickCount = 0;
 }
 if (clickTimer) clearTimeout(clickTimer);
 clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
 };

 let selectionTimer: NodeJS.Timeout | null = null;
 const handleSelection = () => {
 if (selectionTimer) clearTimeout(selectionTimer);
 selectionTimer = setTimeout(() => {
 const selection = window.getSelection();
 const text = selection?.toString().trim();
 if (text && text.length > 0) {
 trackEvent({
 eventType: TELEMETRY_EVENTS.TEXT_HIGHLIGHT,
 metadata: { 
 textLength: text.length,
 textSnippet: text.substring(0, 200)
 }
 });
 }
 }, 500);
 };

 let idleTimer: NodeJS.Timeout | null = null;
 const resetIdle = () => {
 if (idleTimer) clearTimeout(idleTimer);
 idleTimer = setTimeout(() => {
 trackEvent({
 eventType: TELEMETRY_EVENTS.IDLE_ZONEOUT,
 metadata: { idleTimeMs: 30000 }
 });
 resetIdle();
 }, 30000);
 };

 resetIdle();

 let lastActivityTime = 0;
 const handleActivity = () => {
 const now = Date.now();
 if (now - lastActivityTime < 1000) return;
 lastActivityTime = now;
 resetIdle();
 };

 window.addEventListener('mousemove', handleActivity);
 window.addEventListener('scroll', handleActivity);
 window.addEventListener('keydown', handleActivity);

 document.addEventListener('copy', handleCopy);
 document.addEventListener('click', handleClick);
 document.addEventListener('mouseup', handleSelection);

 return () => {
 document.removeEventListener('copy', handleCopy);
 document.removeEventListener('click', handleClick);
 document.removeEventListener('mouseup', handleSelection);
 window.removeEventListener('mousemove', handleActivity);
 window.removeEventListener('scroll', handleActivity);
 window.removeEventListener('keydown', handleActivity);
 if (clickTimer) clearTimeout(clickTimer);
 if (idleTimer) clearTimeout(idleTimer);
 if (selectionTimer) clearTimeout(selectionTimer);
 };
 }, []);

 return <>{children}</>;
}
