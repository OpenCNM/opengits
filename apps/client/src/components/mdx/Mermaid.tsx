'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import mermaid from 'mermaid';
import { stripMermaidDangerousHtml } from '@/lib/mermaid/xss-guard';
import { 
  Copy, 
  Check, 
  Maximize2, 
  Scan, 
  Download, 
  ZoomIn,
  Layers,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import * as m from '@/paraglide/messages';
import MediaLightboxModal from './MediaLightboxModal';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api/client';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { STORAGE_KEYS } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface MermaidProps {
  chart: string;
  title?: string;
}

export type DiagramDepth = 'intuitive' | 'standard' | 'deep';

export function hashDiagramSource(chart: string): string {
  if (!chart) return '0';
  const normalized = chart.trim().replace(/\r\n/g, '\n');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

function safeSetDiagramLensCache(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('diagram_lens_') && k !== key) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
    }
  }
}

export function extractMermaidTitle(chart: string): string | null {
  if (!chart) return null;
  const trimmed = chart.trim();

  const fmMatch = trimmed.match(/^---\s*[\r\n]+(?:[\s\S]*?[\r\n]+)?title\s*:\s*([^\r\n]+)[\r\n]+(?:[\s\S]*?[\r\n]+)?---/i);
  if (fmMatch && fmMatch[1].trim()) return fmMatch[1].trim();

  const dirMatch = trimmed.match(/(?:^|[\r\n]+)\s*(?:accTitle|title)\s*[:\s]\s*([^\r\n]+)/i);
  if (dirMatch && dirMatch[1].trim()) return dirMatch[1].trim();

  const commentMatch = trimmed.match(/(?:^|[\r\n]+)\s*%%\s*(?:title|标题)\s*[:\s]\s*([^\r\n]+)/i);
  if (commentMatch && commentMatch[1].trim()) return commentMatch[1].trim();

  return null;
}

export function inferMermaidTypeLabel(chart: string): string {
  if (!chart) return m.diagram_type_general();
  const lower = chart.trim().toLowerCase();
  if (lower.includes('sequencediagram')) return m.diagram_type_sequence();
  if (lower.includes('classdiagram')) return m.diagram_type_class();
  if (lower.includes('statediagram')) return m.diagram_type_state();
  if (lower.includes('erdiagram')) return m.diagram_type_er();
  if (lower.includes('flowchart') || lower.includes('graph')) return m.diagram_type_flowchart();
  return m.diagram_type_general();
}

export default function Mermaid({ chart: initialChart, title: customTitle }: MermaidProps) {
  const [currentDepth, setCurrentDepth] = useState<DiagramDepth>('intuitive');
  const [activeChart, setActiveChart] = useState<string>(initialChart);
  const [isLoadingDepth, setIsLoadingDepth] = useState(false);
  const [depthErrorObj, setDepthErrorObj] = useState<unknown>(null);

  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [isActualSize, setIsActualSize] = useState(false);
  const elementId = useRef(`mermaid-diagram-${Math.floor(Math.random() * 1000000)}`);

  const activeTargetDepthRef = useRef<DiagramDepth>('intuitive');
  const isMountedRef = useRef(true);

  const storeTheme = useReaderAppearanceStore((s) => s.theme);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeTargetDepthRef.current = 'intuitive';
    setCurrentDepth('intuitive');
    setActiveChart(initialChart);
    setIsLoadingDepth(false);
    setDepthErrorObj(null);
    setError(null);
  }, [initialChart]);

  useEffect(() => {
    const checkDark = () => {
      const isDomDark = typeof document !== 'undefined' && (
        document.documentElement.classList.contains('dark') || 
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        document.body?.classList.contains('dark')
      );
      setIsDark(storeTheme === 'dark' || isDomDark);
    };

    checkDark();

    if (typeof document !== 'undefined') {
      const observer = new MutationObserver(() => {
        checkDark();
      });

      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });

      return () => {
        observer.disconnect();
      };
    }
  }, [storeTheme]);

  const displayTitle = useMemo(() => {
    if (customTitle && customTitle.trim()) return customTitle.trim();
    const extracted = extractMermaidTitle(activeChart);
    if (extracted) return extracted;
    return inferMermaidTypeLabel(activeChart);
  }, [activeChart, customTitle]);

  const fetchDepthDiagram = useCallback(async (targetDepth: DiagramDepth, forceRefresh = false) => {
    activeTargetDepthRef.current = targetDepth;
    if (targetDepth === 'intuitive') {
      setActiveChart(initialChart);
      setDepthErrorObj(null);
      setIsLoadingDepth(false);
      return;
    }

    const chartHash = hashDiagramSource(initialChart);
    const cacheKey = STORAGE_KEYS.DIAGRAM_LENS_CACHE(chartHash, targetDepth);

    if (!forceRefresh && typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached && cached.trim()) {
          setActiveChart(cached);
          setDepthErrorObj(null);
          return;
        }
      } catch {
      }
    }

    setIsLoadingDepth(true);
    setDepthErrorObj(null);

    try {
      const res = await api.post<{ ok: boolean; mermaidCode: string }>('/api/ai/diagram-lens', {
        chart: initialChart,
        targetDepth,
        title: displayTitle,
      });

      if (res?.ok && res.mermaidCode) {
        safeSetDiagramLensCache(cacheKey, res.mermaidCode);
        if (isMountedRef.current && activeTargetDepthRef.current === targetDepth) {
          setActiveChart(res.mermaidCode);
          setDepthErrorObj(null);
        }
      } else {
        throw new Error(m.diagram_lens_failed());
      }
    } catch (err: unknown) {
      console.warn('[Mermaid] Failed to fetch diagram lens:', err);
      if (isMountedRef.current && activeTargetDepthRef.current === targetDepth) {
        setDepthErrorObj(err ?? new Error(m.diagram_lens_failed()));
      }
    } finally {
      if (isMountedRef.current && activeTargetDepthRef.current === targetDepth) {
        setIsLoadingDepth(false);
      }
    }
  }, [initialChart, displayTitle]);

  const handleSelectDepth = useCallback((depth: DiagramDepth) => {
    activeTargetDepthRef.current = depth;
    setCurrentDepth(depth);
    if (depth === 'intuitive') {
      setActiveChart(initialChart);
      setDepthErrorObj(null);
      setIsLoadingDepth(false);
    } else {
      fetchDepthDiagram(depth);
    }
  }, [initialChart, fetchDepthDiagram]);

  const handleRegenerate = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (currentDepth === 'standard' || currentDepth === 'deep') {
      fetchDepthDiagram(currentDepth, true);
    }
  }, [currentDepth, fetchDepthDiagram]);

  const handleRetryDepth = useCallback(() => {
    void fetchDepthDiagram(currentDepth, true);
  }, [currentDepth, fetchDepthDiagram]);

  const handleOpenPreferencesModal = useCallback(() => {
    useModalStore.getState().openPreferencesModal('llm');
  }, []);

  const handleOpenDepthApiKeyModal = useCallback(() => {
    useModalStore.getState().openApiKeyModal({
      onCompleted: () => {
        void fetchDepthDiagram(currentDepth, true);
      },
    });
  }, [currentDepth, fetchDepthDiagram]);

  const isClientOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  const depthErrorPresentation = useMemo(() => {
    if (!depthErrorObj) return null;
    return resolveUpstreamErrorPresentation(depthErrorObj, {
      offline: isClientOffline,
      fallbackTitle: m.diagram_lens_failed(),
      fallbackDesc: m.common_retry_later(),
    });
  }, [depthErrorObj, isClientOffline]);

  useEffect(() => {
    let isMounted = true;

    const renderDiagram = async () => {
      const renderId = `mermaid-diagram-${Math.floor(Math.random() * 10000000)}`;
      try {
        const isThemeDark = isDark;
        mermaid.initialize({
          startOnLoad: false,
          theme: isThemeDark ? 'dark' : 'neutral',
          securityLevel: 'antiscript',
          fontFamily: 'Inter, system-ui, sans-serif',
          suppressErrorRendering: true,
          themeVariables: isThemeDark
            ? {
                darkMode: true,
                background: 'transparent',
                mainBkg: 'rgb(28, 28, 31)',
                nodeBorder: 'rgb(63, 63, 70)',
                defaultLinkColor: 'rgb(161, 161, 170)',
                lineColor: 'rgb(161, 161, 170)',
                textColor: 'rgb(237, 237, 237)',
                primaryColor: 'rgb(28, 28, 31)',
                primaryBorderColor: 'rgb(63, 63, 70)',
                primaryTextColor: 'rgb(237, 237, 237)',
                secondaryColor: 'rgb(39, 39, 42)',
                secondaryBorderColor: 'rgb(63, 63, 70)',
                secondaryTextColor: 'rgb(237, 237, 237)',
                tertiaryColor: 'rgb(39, 39, 42)',
                tertiaryBorderColor: 'rgb(63, 63, 70)',
                tertiaryTextColor: 'rgb(237, 237, 237)',
                clusterBkg: 'rgb(20, 20, 22)',
                clusterBorder: 'rgb(39, 39, 42)',
                edgeLabelBackground: 'rgb(24, 24, 27)',
                titleColor: 'rgb(237, 237, 237)',
                nodeTextColor: 'rgb(237, 237, 237)',
              }
            : {
                darkMode: false,
                background: 'transparent',
                mainBkg: 'rgb(250, 250, 250)',
                nodeBorder: 'rgb(228, 228, 231)',
                defaultLinkColor: 'rgb(82, 82, 91)',
                lineColor: 'rgb(82, 82, 91)',
                textColor: 'rgb(10, 10, 10)',
                primaryColor: 'rgb(250, 250, 250)',
                primaryBorderColor: 'rgb(212, 212, 216)',
                primaryTextColor: 'rgb(10, 10, 10)',
                secondaryColor: 'rgb(244, 244, 245)',
                secondaryBorderColor: 'rgb(228, 228, 231)',
                secondaryTextColor: 'rgb(10, 10, 10)',
                tertiaryColor: 'rgb(244, 244, 245)',
                tertiaryBorderColor: 'rgb(228, 228, 231)',
                tertiaryTextColor: 'rgb(10, 10, 10)',
                clusterBkg: 'rgb(255, 255, 255)',
                clusterBorder: 'rgb(228, 228, 231)',
                edgeLabelBackground: 'rgb(255, 255, 255)',
                titleColor: 'rgb(10, 10, 10)',
                nodeTextColor: 'rgb(10, 10, 10)',
              },
        });
        setError(null);

        const rawChart = stripMermaidDangerousHtml(activeChart.trim());

        const parseResult = await mermaid.parse(rawChart, { suppressErrors: true });
        if (parseResult === false) {
          throw new Error('Mermaid syntax error');
        }

        const { svg: renderedSvg } = await mermaid.render(renderId, rawChart);

        if (isMounted) {
          setSvg(renderedSvg);
        }
      } catch (err: any) {
        const garbage = document.getElementById(renderId) || document.getElementById(`d${renderId}`);
        if (garbage) garbage.remove();

        if (isMounted) {
          setSvg('');
          setError(err?.message || 'Failed to render flowchart');
          if (currentDepth !== 'intuitive' && typeof window !== 'undefined') {
            try {
              const chartHash = hashDiagramSource(initialChart);
              const cacheKey = STORAGE_KEYS.DIAGRAM_LENS_CACHE(chartHash, currentDepth);
              localStorage.removeItem(cacheKey);
            } catch {
            }
          }
        }
      }
    };

    renderDiagram();

    return () => {
      isMounted = false;
    };
  }, [activeChart, isDark, currentDepth, initialChart]);

  const handleCopy = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(activeChart.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeChart]);

  const handleDownloadSvg = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeFilename = displayTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || 'diagram';
    a.download = `${safeFilename}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [svg, displayTitle]);

  if (error) {
    const rawChart = activeChart.trim();
    const mermaidState = {
      code: rawChart,
      mermaid: { theme: 'default' },
      autoSync: true,
      updateEditor: true
    };
    let base64State = '';
    if (typeof window !== 'undefined') {
      base64State = window.btoa(unescape(encodeURIComponent(JSON.stringify(mermaidState))));
    }
    const liveLink = `https://mermaid.live/edit#base64:${base64State}`;
    return (
      <div className="my-6 border border-theme-border/80 rounded-2xl shadow-sm overflow-hidden bg-theme-surface">
        <div className="flex items-center justify-between px-4 py-3 bg-theme-accent/5 border-b border-theme-border/80">
          <span className="text-sm font-semibold text-theme-foreground">{displayTitle} ({m.diagram_source_view()})</span>
          <div className="flex items-center gap-3">
            {currentDepth !== 'intuitive' && (
              <>
                <button
                  type="button"
                  onClick={() => fetchDepthDiagram(currentDepth, true)}
                  disabled={isLoadingDepth}
                  className="flex items-center gap-1 text-xs text-theme-primary hover:underline cursor-pointer disabled:opacity-50"
                  title={m.diagram_lens_regenerate()}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", isLoadingDepth && "animate-spin")} />
                  <span>{m.diagram_lens_regenerate()}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectDepth('intuitive')}
                  className="text-xs text-theme-muted hover:text-theme-foreground hover:underline cursor-pointer"
                >
                  {m.diagram_lens_revert_default()}
                </button>
              </>
            )}
            <a 
              href={liveLink}
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-theme-primary hover:underline"
            >
              {m.diagram_edit_online()}
            </a>
            <button 
              onClick={handleCopy}
              className="flex items-center gap-1 text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? m.diagram_copied() : m.diagram_copy_source()}</span>
            </button>
          </div>
        </div>
        <div className="p-4 bg-theme-bg overflow-x-auto text-xs font-mono text-theme-foreground">
          <pre className="whitespace-pre-wrap">{rawChart}</pre>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="group/mermaid relative my-8 p-6 bg-theme-surface border border-theme-border/80 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 overflow-x-auto">
        {(svg || isLoadingDepth) && (
          <div className={cn(
            "absolute top-3 right-3 flex items-center gap-1 p-1 rounded-xl bg-theme-bg/85 border border-theme-border/80 backdrop-blur-md transition-opacity duration-200 z-10 shadow-sm",
            currentDepth !== 'intuitive' || isLoadingDepth ? "opacity-100" : "opacity-0 group-hover/mermaid:opacity-100 focus-within:opacity-100"
          )}>
            <Menu>
              <MenuTrigger
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer outline-none"
                title={m.diagram_lens_tooltip()}
              >
                <Layers className="w-3.5 h-3.5 text-theme-primary" />
                <span className="font-medium text-xs">
                  {currentDepth === 'intuitive'
                    ? m.diagram_lens_label_intuitive()
                    : currentDepth === 'standard'
                    ? m.diagram_lens_label_standard()
                    : m.diagram_lens_label_deep()}
                </span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </MenuTrigger>
              <MenuPopup align="end" sideOffset={6} className="w-48 bg-theme-bg border border-theme-border/80 shadow-xl rounded-xl p-1 z-50">
                <MenuItem
                  onClick={() => handleSelectDepth('intuitive')}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-xs rounded-lg cursor-pointer flex items-center justify-between transition-colors",
                    currentDepth === 'intuitive'
                      ? "bg-theme-muted/20 text-theme-foreground font-medium"
                      : "text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/10"
                  )}
                >
                  <span>{m.diagram_lens_depth_intuitive()}</span>
                  {currentDepth === 'intuitive' && <Check className="w-3.5 h-3.5 text-theme-primary" />}
                </MenuItem>
                <MenuItem
                  onClick={() => handleSelectDepth('standard')}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-xs rounded-lg cursor-pointer flex items-center justify-between transition-colors",
                    currentDepth === 'standard'
                      ? "bg-theme-muted/20 text-theme-foreground font-medium"
                      : "text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/10"
                  )}
                >
                  <span>{m.diagram_lens_depth_standard()}</span>
                  {currentDepth === 'standard' && <Check className="w-3.5 h-3.5 text-theme-primary" />}
                </MenuItem>
                <MenuItem
                  onClick={() => handleSelectDepth('deep')}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-xs rounded-lg cursor-pointer flex items-center justify-between transition-colors",
                    currentDepth === 'deep'
                      ? "bg-theme-muted/20 text-theme-foreground font-medium"
                      : "text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/10"
                  )}
                >
                  <span>{m.diagram_lens_depth_deep()}</span>
                  {currentDepth === 'deep' && <Check className="w-3.5 h-3.5 text-theme-primary" />}
                </MenuItem>
              </MenuPopup>
            </Menu>

            {currentDepth !== 'intuitive' && (
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={isLoadingDepth}
                className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer disabled:opacity-50"
                title={m.diagram_lens_regenerate()}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", isLoadingDepth && "animate-spin text-theme-primary")} />
              </button>
            )}

            <div className="w-[1px] h-3.5 bg-theme-border/80 mx-0.5" />

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsActualSize((prev) => !prev);
              }}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
              title={isActualSize ? m.diagram_fit() : m.diagram_actual_size()}
            >
              {isActualSize ? <Scan className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsLightboxOpen(true);
              }}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
              title={m.diagram_fullscreen()}
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={handleDownloadSvg}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
              title={m.diagram_download_svg()}
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={handleCopy}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
              title={copied ? m.diagram_copied() : m.diagram_copy_source()}
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        )}

        {isLoadingDepth ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Spinner className="w-5 h-5 text-theme-primary animate-spin" />
            <span className="text-xs text-theme-muted animate-pulse">
              {m.diagram_lens_regenerating()}
            </span>
          </div>
        ) : depthErrorPresentation ? (
          <div className="py-4">
            <UpstreamErrorNotice
              variant="banner"
              isOffline={isClientOffline}
              error={depthErrorPresentation}
              onRetry={handleRetryDepth}
              retryLabel={m.diagram_lens_retry()}
              onModelSwitched={handleRetryDepth}
              onOpenPreferencesModal={handleOpenPreferencesModal}
              onOpenApiKeyModal={handleOpenDepthApiKeyModal}
              extraActions={
                <button
                  type="button"
                  onClick={() => handleSelectDepth('intuitive')}
                  className="inline-flex items-center justify-center gap-1.5 text-xs border border-theme-border text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer font-serif px-3.5 py-1.5 rounded-lg"
                >
                  {m.diagram_lens_revert_default()}
                </button>
              }
            />
          </div>
        ) : svg ? (
          <div 
            onClick={() => setIsLightboxOpen(true)}
            className={`cursor-zoom-in transition-all duration-200 ${
              isActualSize 
                ? 'w-auto max-w-none flex justify-start [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-none' 
                : 'w-full max-w-full flex justify-center [&>svg]:h-auto [&>svg]:max-w-full [&>svg]:mx-auto'
            }`}
            title={m.diagram_click_to_zoom()}
            dangerouslySetInnerHTML={{ __html: svg }} 
          />
        ) : (
          <div className="text-xs text-theme-muted animate-pulse py-4 text-center">
            {m.mermaid_generating()}
          </div>
        )}

        {svg && !isLoadingDepth && (
          <div className="mt-3 flex justify-between items-center text-xs text-theme-muted/70 select-none px-1">
            <span className="opacity-0 group-hover/mermaid:opacity-100 transition-opacity duration-200 flex items-center gap-1">
              <ZoomIn className="w-3 h-3" />
              <span>{m.diagram_click_to_zoom()}</span>
            </span>
            {isActualSize && (
              <span className="text-xs text-theme-primary bg-theme-primary/10 px-1.5 py-0.5 rounded">
                {m.diagram_actual_size()}
              </span>
            )}
          </div>
        )}
      </div>

      <MediaLightboxModal
        isOpen={isLightboxOpen}
        onClose={() => setIsLightboxOpen(false)}
        svgHtml={svg}
        sourceCode={activeChart}
        title={displayTitle}
      />
    </>
  );
}
