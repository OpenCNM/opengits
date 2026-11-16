'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';

export interface ComponentErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackDescription?: string;
  className?: string;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ComponentErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * 局部轻量组件错误边界：
 * 防止 Mermaid 图表解析、MicroQuiz 挂件等局部小部件崩溃拖垮整页。
 */
export class ComponentErrorBoundary extends Component<
  ComponentErrorBoundaryProps,
  ComponentErrorBoundaryState
> {
  constructor(props: ComponentErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ComponentErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, info);
    } else {
      console.warn('[ComponentErrorBoundary] Caught render error:', error, info);
    }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error || new Error('Unknown error'), this.handleReset);
      }
      return this.props.fallback;
    }

    return (
      <div
        className={cn(
          'my-3 p-3.5 rounded-xl border border-theme-border/80 bg-theme-surface/50 text-xs font-sans flex items-start justify-between gap-3 shadow-2xs',
          this.props.className
        )}
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <AlertCircle className="w-4 h-4 text-theme-muted/70 mt-0.5 shrink-0" />
          <div className="space-y-0.5 min-w-0">
            <p className="font-medium text-theme-foreground truncate">
              {this.props.fallbackTitle || m.error_component_load_failed()}
            </p>
            <p className="text-micro text-theme-muted truncate">
              {this.props.fallbackDescription || this.state.error?.message || m.error_content_render_failed()}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={this.handleReset}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-theme-border bg-theme-bg text-micro text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer shrink-0 font-medium"
        >
          <RefreshCw className="w-3 h-3 text-theme-muted" />
          {m.common_retry()}
        </button>
      </div>
    );
  }
}
