import type { RelayOutlineChapter, RelayOutlineNode } from './useUpdateWorkbench';
import * as m from '@/paraglide/messages';

export interface FlatRelayNodeItem {
  node: RelayOutlineNode;
  chapter: RelayOutlineChapter;
  chapterIndex: number;
  nodeIndexInChapter: number;
  globalIndex: number;
}

export interface RelayRecommendation {
  node: RelayOutlineNode;
  chapter: RelayOutlineChapter;
  chapterIndex: number;
  nodeIndexInChapter: number;
  globalIndex: number;
  displayTitle: string;
  chapterDisplayTitle: string;
  reason: string;
  badge: string;
  prevCompletedTitle?: string | null;
}

const COMMON_CHAPTER_TRANSLATIONS: Record<string, string> = {
  introduction: '入门概览',
  intro: '入门引导',
  installation: '安装与部署',
  install: '安装指南',
  setup: '环境初始化',
  quickstart: '快速上手',
  overview: '概览与设计',
  cli: '命令行工具',
  api: '接口与协议',
  faq: '常见问题',
  guide: '核心指南',
  configuration: '配置说明',
  config: '配置项',
  preferences: '偏好设置',
  plugins: '插件生态',
  plugin: '插件系统',
  models: '模型管理',
  usage: '使用指南',
  readme: '项目自述',
  troubleshooting: '故障排除',
  architecture: '系统架构',
  deployment: '多平台部署',
  benchmark: '性能评测',
  contributing: '贡献指南',
  changelog: '更新日志',
  'file import': '文件导入',
  'live recording': '实时录音',
  'speaker identification': '说话人识别',
  translations: '字幕翻译与导出',
  transcription: '核心语音转录',
  export: '导出与输出',
};

export function formatRelayDisplayTitle(
  rawTitle: string,
  path: string,
  nodeIndexInChapter: number
): string {
  const sectionPrefix = `第 ${nodeIndexInChapter + 1} 节`;
  const cleanTitle = (rawTitle || path.split('/').pop()?.replace(/\.[^/.]+$/, '') || '').trim();

  if (/\p{Script=Han}/u.test(cleanTitle)) {
    if (/^第\s*\d+\s*节/u.test(cleanTitle)) {
      return cleanTitle;
    }
    return `${sectionPrefix} · ${cleanTitle}`;
  }

  const lower = cleanTitle.toLowerCase();
  const matchedCn = COMMON_CHAPTER_TRANSLATIONS[lower];

  if (matchedCn) {
    return `${sectionPrefix} · ${cleanTitle} (${matchedCn})`;
  }

  return `${sectionPrefix} · ${cleanTitle}`;
}

export function findRecommendedRelayNode(
  outline: RelayOutlineChapter[],
  preferredJobOrDocId?: string | null
): RelayRecommendation | null {
  if (!outline || outline.length === 0) return null;

  const flat: FlatRelayNodeItem[] = [];
  outline.forEach((ch, chIdx) => {
    (ch.nodes || []).forEach((node, nIdx) => {
      flat.push({
        node,
        chapter: ch,
        chapterIndex: chIdx,
        nodeIndexInChapter: nIdx,
        globalIndex: flat.length,
      });
    });
  });

  const unprocessed = flat.filter((item) => item.node.status === 'UNPROCESSED');
  if (unprocessed.length === 0) return null;

  if (preferredJobOrDocId) {
    const matched = unprocessed.find(
      (item) =>
        item.node.jobId === preferredJobOrDocId ||
        item.node.documentId === preferredJobOrDocId ||
        item.node.id === preferredJobOrDocId
    );
    if (matched) {
      return buildRecommendation(matched, m.relay_rec_current_title(), m.relay_rec_current_badge());
    }
  }

  for (const item of unprocessed) {
    const prev = flat[item.globalIndex - 1];
    const next = flat[item.globalIndex + 1];
    const prevActive = prev && (prev.node.status === 'PROCESSED' || prev.node.status === 'CLAIMED');
    const nextActive = next && (next.node.status === 'PROCESSED' || next.node.status === 'CLAIMED');
    if (prevActive && nextActive) {
      return buildRecommendation(
        item,
        m.relay_rec_stitch_title(),
        m.relay_rec_stitch_badge()
      );
    }
  }

  for (const item of unprocessed) {
    const prev = flat[item.globalIndex - 1];
    if (prev && prev.node.status === 'PROCESSED') {
      const prevTitle = prev.node.title;
      return buildRecommendation(
        item,
        m.relay_rec_continue_title({ title: prevTitle }),
        m.relay_rec_continue_badge(),
        prevTitle
      );
    }
  }

  for (const item of unprocessed) {
    const chNodes = item.chapter.nodes || [];
    const chHasProcessed = chNodes.some((n) => n.status === 'PROCESSED');
    if (chHasProcessed) {
      return buildRecommendation(
        item,
        m.relay_rec_chapter_title(),
        m.relay_rec_chapter_badge()
      );
    }
  }

  for (const item of unprocessed) {
    const next = flat[item.globalIndex + 1];
    if (next && next.node.status === 'PROCESSED') {
      return buildRecommendation(
        item,
        m.relay_rec_prequel_title(),
        m.relay_rec_prequel_badge()
      );
    }
  }

  const first = unprocessed[0];
  const isFirstEver = first.globalIndex === 0;
  return buildRecommendation(
    first,
    isFirstEver ? m.relay_rec_first_title() : m.relay_rec_topo_title(),
    isFirstEver ? m.relay_rec_first_badge() : m.relay_rec_topo_badge()
  );
}

function buildRecommendation(
  item: FlatRelayNodeItem,
  reason: string,
  badge: string,
  prevCompletedTitle?: string | null
): RelayRecommendation {
  return {
    node: item.node,
    chapter: item.chapter,
    chapterIndex: item.chapterIndex,
    nodeIndexInChapter: item.nodeIndexInChapter,
    globalIndex: item.globalIndex,
    displayTitle: formatRelayDisplayTitle(item.node.title, item.node.path, item.nodeIndexInChapter),
    chapterDisplayTitle: item.chapter.title,
    reason,
    badge,
    prevCompletedTitle: prevCompletedTitle ?? null,
  };
}

export { docPathToSlug } from '@/lib/outline-reader';
