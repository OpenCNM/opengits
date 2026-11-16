'use client';

import dynamic from 'next/dynamic';

// ── 重型客户端组件的懒加载入口（性能修复 2026-10-13 接线）──
// mermaid（~1.5MB chunk）此前经静态 import 链进入首页/阅读页首屏 bundle；
// 改经本 'use client' 包装模块 dynamic 挂载（ssr:false 必须位于客户端模块——
// docs-mdx-runtime 无 'use client' 且被 Server Component 共享）。
// loading 占位与 Mermaid SSR 输出的「生成中」样式保持一致（防 CLS）。
const MermaidLoading = () => (
  <div className="my-8 p-6 bg-theme-surface border border-theme-border/80 rounded-2xl">
    <div className="text-xs text-theme-muted animate-pulse py-4 text-center">…</div>
  </div>
);

export const Mermaid = dynamic(() => import('./Mermaid'), {
  ssr: false,
  loading: MermaidLoading,
});
