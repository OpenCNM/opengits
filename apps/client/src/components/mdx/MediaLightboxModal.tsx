'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Download, 
  Copy, 
  Check, 
  X,
  Scan
} from 'lucide-react';
import * as m from '@/paraglide/messages';

export interface MediaLightboxModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  svgHtml?: string;
  imageSrc?: string;
  alt?: string;
  sourceCode?: string;
}

export default function MediaLightboxModal({
  isOpen,
  onClose,
  title,
  svgHtml,
  imageSrc,
  alt = 'Diagram',
  sourceCode,
}: MediaLightboxModalProps) {
  // 解析 SVG 的固有尺寸 (从 viewBox 提取，绝不发生尺寸塌缩为 0)
  const intrinsicDimensions = useMemo(() => {
    if (!svgHtml) return null;
    const match = svgHtml.match(/viewBox=["']\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*["']/i);
    if (match) {
      const w = parseFloat(match[3]);
      const h = parseFloat(match[4]);
      if (!isNaN(w) && w > 0 && !isNaN(h) && h > 0) {
        return { width: Math.round(w), height: Math.round(h) };
      }
    }
    return null;
  }, [svgHtml]);

  // 计算刚打开时的最佳自适应比例 (Fit Scale)
  const defaultFitScale = useMemo(() => {
    if (typeof window === 'undefined') return 1;
    if (intrinsicDimensions) {
      const maxW = window.innerWidth * 0.85;
      const maxH = window.innerHeight * 0.75;
      const scaleX = maxW / intrinsicDimensions.width;
      const scaleY = maxH / intrinsicDimensions.height;
      const calculated = Math.min(scaleX, scaleY, 1.25);
      return Math.round(Math.max(calculated, 0.3) * 100) / 100;
    }
    return 1;
  }, [intrinsicDimensions]);

  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastTouchRef = useRef<{ dist: number; center: { x: number; y: number } } | null>(null);

  // 打开时以智能自适应比例居中呈现
  useEffect(() => {
    if (isOpen) {
      setScale(defaultFitScale);
      setPosition({ x: 0, y: 0 });
      setIsDragging(false);
    }
  }, [isOpen, defaultFitScale]);

  // 快捷键 Esc 关闭由 DialogPrimitive 处理，+ / - / 0 处理缩放
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomByFactor(1.2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomByFactor(0.83);
      } else if (e.key === '0') {
        e.preventDefault();
        resetToFit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, scale, position, defaultFitScale]);

  const zoomByFactor = useCallback((factor: number) => {
    setScale((prev) => {
      const next = Math.min(Math.max(prev * factor, 0.2), 6);
      return Math.round(next * 100) / 100;
    });
  }, []);

  const resetToFit = useCallback(() => {
    setScale(defaultFitScale);
    setPosition({ x: 0, y: 0 });
  }, [defaultFitScale]);

  const setActualSize = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // 鼠标滚轮以光标为中心缩放
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const viewport = viewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const cursorX = e.clientX - rect.left - rect.width / 2;
    const cursorY = e.clientY - rect.top - rect.height / 2;

    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    const newScale = Math.min(Math.max(scale * factor, 0.2), 6);
    const ratio = newScale / scale;

    setPosition((prev) => ({
      x: cursorX - (cursorX - prev.x) * ratio,
      y: cursorY - (cursorY - prev.y) * ratio,
    }));
    setScale(Math.round(newScale * 100) / 100);
  };

  // 鼠标拖拽平移
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 容错捕获
    }
  };

  // 双击智能切换放大/复位
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (Math.abs(scale - defaultFitScale) > 0.05) {
      resetToFit();
    } else {
      setScale(Math.min(defaultFitScale * 1.8, 4));
      const viewport = viewportRef.current;
      if (viewport) {
        const rect = viewport.getBoundingClientRect();
        const cursorX = e.clientX - rect.left - rect.width / 2;
        const cursorY = e.clientY - rect.top - rect.height / 2;
        setPosition({
          x: cursorX - cursorX * 1.8,
          y: cursorY - cursorY * 1.8,
        });
      }
    }
  };

  // 触控双指捏合
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const center = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2,
      };
      lastTouchRef.current = { dist, center };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchRef.current) {
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const factor = dist / lastTouchRef.current.dist;

      const viewport = viewportRef.current;
      if (viewport) {
        const rect = viewport.getBoundingClientRect();
        const cursorX = lastTouchRef.current.center.x - rect.left - rect.width / 2;
        const cursorY = lastTouchRef.current.center.y - rect.top - rect.height / 2;
        const newScale = Math.min(Math.max(scale * factor, 0.2), 6);
        const ratio = newScale / scale;

        setPosition((prev) => ({
          x: cursorX - (cursorX - prev.x) * ratio,
          y: cursorY - (cursorY - prev.y) * ratio,
        }));
        setScale(Math.round(newScale * 100) / 100);
      }
      lastTouchRef.current.dist = dist;
    }
  };

  const handleTouchEnd = () => {
    lastTouchRef.current = null;
  };

  // 隔离 SVG 内部 ID，避免与正文 DOM ID 冲突
  const preparedSvg = useMemo(() => {
    if (!svgHtml) return '';
    const idMatch = svgHtml.match(/id=["'](mermaid-diagram-[0-9]+)["']/i);
    if (idMatch) {
      const origId = idMatch[1];
      const newId = `${origId}-lightbox`;
      return svgHtml.replaceAll(origId, newId);
    }
    return svgHtml;
  }, [svgHtml]);

  // 复制源码
  const handleCopySource = () => {
    if (!sourceCode) return;
    navigator.clipboard.writeText(sourceCode.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 下载图表文件
  const handleDownload = () => {
    if (svgHtml) {
      const blob = new Blob([svgHtml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'diagram'}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (imageSrc) {
      const a = document.createElement('a');
      a.href = imageSrc;
      a.download = `${title || 'diagram-image'}`;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const displayTitle = title || alt || m.diagram_fullscreen();

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        {/* 背景毛玻璃遮罩 */}
        <DialogPrimitive.Backdrop 
          className="fixed inset-0 z-[200] bg-black/85 backdrop-blur-md transition-opacity duration-200"
        />

        {/* 全屏视窗 Popup */}
        <DialogPrimitive.Popup
          className="fixed inset-0 z-[201] flex flex-col justify-between overflow-hidden select-none outline-none focus:outline-none"
        >
          {/* 顶栏控制条 */}
          <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/70 to-transparent pointer-events-auto z-10">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-white/95 truncate max-w-md">
                {displayTitle}
              </span>
              <span className="text-xs text-white/60 bg-white/10 px-2 py-0.5 rounded-full font-mono">
                {Math.round(scale * 100)}%
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-1 text-xs text-white/50 mr-2">
                <kbd className="px-1.5 py-0.5 rounded border border-white/20 bg-white/10 font-mono text-xs text-white/80">Esc</kbd>
                <span>{m.diagram_exit()}</span>
              </span>
              <DialogPrimitive.Close
                onClick={onClose}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-colors cursor-pointer"
                title={m.common_close()}
              >
                <X className="w-5 h-5" />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* 中央无限画布 Viewport */}
          <div
            ref={viewportRef}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDoubleClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className={`flex-1 relative flex items-center justify-center overflow-hidden touch-none ${
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            }`}
          >
            {/* 可变形画布容器 */}
            <div
              style={{
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.08s ease-out',
              }}
              className="max-w-none flex items-center justify-center p-8 pointer-events-none"
            >
              {preparedSvg ? (
                /* 画板底衬卡片 (Paper Board)：提供与正文完全一致的高对比度浅色/主题底色，彻底杜绝黑底黑字隐形与尺寸塌缩 */
                <div
                  style={{
                    width: intrinsicDimensions ? `${intrinsicDimensions.width}px` : 'auto',
                    minWidth: intrinsicDimensions ? undefined : '500px',
                  }}
                  className="mermaid-lightbox-viewport relative rounded-2xl bg-theme-surface border border-theme-border/80 shadow-2xl p-6 sm:p-10 transition-shadow"
                >
                  <div
                    className="w-full flex justify-center [&>svg]:w-full [&>svg]:h-auto [&>svg]:block [&>svg]:max-w-none"
                    dangerouslySetInnerHTML={{ __html: preparedSvg }}
                  />
                </div>
              ) : imageSrc ? (
                <div className="relative rounded-2xl bg-theme-surface border border-theme-border/80 shadow-2xl p-2 sm:p-4 overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageSrc}
                    alt={alt}
                    className="max-w-[90vw] max-h-[80vh] object-contain rounded-xl block"
                    draggable={false}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* 底部悬浮控制 Dock */}
          <div className="flex justify-center pb-6 pt-2 bg-gradient-to-t from-black/70 to-transparent pointer-events-none z-10">
            <div className="flex items-center gap-1.5 p-1.5 rounded-2xl bg-theme-surface/95 border border-theme-border/80 shadow-2xl backdrop-blur-xl pointer-events-auto text-theme-foreground">
              {/* 缩小 */}
              <button
                type="button"
                onClick={() => zoomByFactor(0.8)}
                className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={m.diagram_zoom_out()}
              >
                <ZoomOut className="w-4 h-4" />
              </button>

              {/* 缩放比例重置 (点击恢复自适应最佳视野) */}
              <button
                type="button"
                onClick={resetToFit}
                className="px-2.5 py-1 text-xs font-mono font-medium rounded-xl text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={m.diagram_fit()}
              >
                {Math.round(scale * 100)}%
              </button>

              {/* 放大 */}
              <button
                type="button"
                onClick={() => zoomByFactor(1.25)}
                className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={m.diagram_zoom_in()}
              >
                <ZoomIn className="w-4 h-4" />
              </button>

              <div className="w-[1px] h-4 bg-theme-border/80 mx-1" />

              {/* 适应屏幕 */}
              <button
                type="button"
                onClick={resetToFit}
                className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={m.diagram_fit()}
              >
                <Scan className="w-4 h-4" />
              </button>

              {/* 1:1 实际尺寸 */}
              <button
                type="button"
                onClick={setActualSize}
                className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={m.diagram_actual_size()}
              >
                <Maximize2 className="w-4 h-4" />
              </button>

              {/* 复制源码 (仅当有时) */}
              {sourceCode && (
                <button
                  type="button"
                  onClick={handleCopySource}
                  className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                  title={copied ? m.diagram_copied() : m.diagram_copy_source()}
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              )}

              {/* 下载 */}
              <button
                type="button"
                onClick={handleDownload}
                className="p-2 rounded-xl text-theme-muted hover:text-theme-foreground hover:bg-theme-muted/15 transition-colors cursor-pointer"
                title={svgHtml ? m.diagram_download_svg() : m.diagram_download_image()}
              >
                <Download className="w-4 h-4" />
              </button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
