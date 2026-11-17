import { OgLoading } from '@/components/ui/OgLoading';
import * as m from '@/paraglide/messages';

/**
 * 教程与文档页面路由初始化 Loading（Next.js App Router 官方标准过渡）
 * 当用户从首页卡片、搜索框或弹窗点击进入 /docs/[owner]/[repo] 时，
 * Next.js 会在 0ms 内先渲染本组件，展现品牌双向对冲动效，彻底消除线上网络与服务端渲染延迟感。
 */
export default function DocsLoading() {
  return (
    <OgLoading
      fullPage
      size="xl"
      text={m.uninitialized_chapter_ready_loading?.() || m.common_loading()}
    />
  );
}
