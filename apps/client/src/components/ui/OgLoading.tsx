'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export type OgLoadingSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

export interface OgSpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 尺寸大小：预设 ('xs': 14px, 'sm': 18px, 'md': 28px, 'lg': 48px, 'xl': 56px) 或自定义像素数值
   * @default 'md' (28px)
   */
  size?: OgLoadingSize;
  /**
   * 动画单次完整周期秒数
   * @default 1.2
   */
  speedSec?: number;
  /**
   * 是否显示透明度约 8% 的静止微导轨（深浅主题均能极大增强视觉连贯性）
   * @default true
   */
  showTrack?: boolean;
  /**
   * 图标额外的 SVG class
   */
  svgClassName?: string;
}

const SIZE_MAP: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', number> = {
  xs: 14,
  sm: 18,
  md: 28,
  lg: 48,
  xl: 56,
};

function resolveSize(size: OgLoadingSize): number {
  if (typeof size === 'number') return size;
  return SIZE_MAP[size] ?? 28;
}

/**
 * OgSpinner: 纯原子 SVG 动效图标组件
 * 专为按钮内嵌、表格行内、标签、小卡片等高密场景设计，
 * 默认直接继承父容器文字颜色 (currentColor)，适配任意主题与按钮背景。
 */
export function OgSpinner({
  size = 'md',
  speedSec = 1.2,
  showTrack = true,
  className,
  svgClassName,
  style,
  ...props
}: OgSpinnerProps) {
  const pixelSize = resolveSize(size);

  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("relative inline-flex items-center justify-center shrink-0 select-none text-current", className)}
      style={{
        width: pixelSize,
        height: pixelSize,
        ['--og-dur' as string]: `${speedSec}s`,
        ...style,
      }}
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        className={cn("w-full h-full overflow-visible", svgClassName)}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 1. 引导底轨（透明度 8%，适配所有主题） */}
        {showTrack && (
          <g className="opacity-[0.08]" stroke="currentColor" strokeWidth="1.2">
            <circle cx="10.5" cy="14" r="5" />
            <circle cx="21" cy="12.5" r="3.8" />
            <path d="M24.8 12.5v9.5c0 3-2.2 4.8-5.8 4.8h-4" />
          </g>
        )}

        {/* 2. 左侧字母 o：逆时针对冲向下画圆 */}
        <circle
          cx="10.5"
          cy="14"
          r="5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="animate-og-confluence-o"
        />

        {/* 3. 右侧字母 g：顺时针向下画出头部与下尾钩，在底部精准对冲闭合 */}
        <g className="animate-og-confluence-g">
          <circle cx="21" cy="12.5" r="3.8" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="M24.8 12.5v9.5c0 3-2.2 4.8-5.8 4.8h-4"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}

export interface OgLoadingProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 尺寸大小
   * @default fullPage 时为 'xl' (56px), 默认非 fullPage 时为 'lg' (48px)
   */
  size?: OgLoadingSize;
  /**
   * 加载提示文案
   */
  text?: React.ReactNode;
  /**
   * 是否采用全页面居中布局（默认 min-h-[70vh] 居中呈现，非常适合页面级或教程初始化）
   * @default false
   */
  fullPage?: boolean;
  /**
   * 是否采用行内紧凑模式（与文字水平居中并排，适合按钮或标题侧提示）
   * @default false
   */
  inline?: boolean;
  /**
   * 动画单次周期秒数
   * @default 1.2
   */
  speedSec?: number;
  /**
   * 是否显示微导轨
   * @default true
   */
  showTrack?: boolean;
  /**
   * 传递给图标的 className
   */
  iconClassName?: string;
  /**
   * 传递给文字的 className
   */
  textClassName?: string;
}

/**
 * OgLoading: 全局响应式品牌 Loading 容器组件
 * 
 * 使用方式示例：
 * 1. 页面级/教程路由初始化：
 *    `<OgLoading fullPage text="正在构建知识图谱与教程内容..." />`
 * 
 * 2. 对话框/卡片局部居中：
 *    `<OgLoading size="md" text="加载大纲中..." className="py-12" />`
 * 
 * 3. 按钮内嵌加载：
 *    `<button disabled><OgLoading inline size="sm" text="正在打开..." /></button>`
 *    或直接使用纯图标：`<button disabled><OgSpinner size={16} /> <span>阅读中...</span></button>`
 */
export function OgLoading({
  size,
  text,
  fullPage = false,
  inline = false,
  speedSec = 1.2,
  showTrack = true,
  className,
  iconClassName,
  textClassName,
  ...props
}: OgLoadingProps) {
  // 根据不同模式决定合理的默认尺寸
  const effectiveSize = size ?? (fullPage ? 'xl' : inline ? 'sm' : 'lg');

  // 行内并排模式（例如嵌入在按钮内部或行内状态行）
  if (inline) {
    return (
      <div
        role="status"
        className={cn("inline-flex items-center gap-2 select-none text-current", className)}
        {...props}
      >
        <OgSpinner
          size={effectiveSize}
          speedSec={speedSec}
          showTrack={showTrack}
          className={iconClassName}
        />
        {text && (
          <span className={cn("text-xs font-sans tracking-normal", textClassName)}>
            {text}
          </span>
        )}
      </div>
    );
  }

  // 垂直居中容器模式（全页面级或卡片级）
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 select-none text-theme-foreground transition-opacity",
        fullPage ? "min-h-[70vh] w-full p-6 bg-theme-bg" : "py-8",
        className
      )}
      {...props}
    >
      <OgSpinner
        size={effectiveSize}
        speedSec={speedSec}
        showTrack={showTrack}
        className={iconClassName}
      />
      {text && (
        <div
          className={cn(
            "text-xs font-mono tracking-wider text-theme-muted animate-pulse text-center max-w-xs",
            textClassName
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}
