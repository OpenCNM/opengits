import { ConceptNodeItem } from '@/lib/mcp/concept-schemas';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';
import { normalizeHeadingKey } from './heading-key';
import { t } from '@/lib/i18n';

export { normalizeHeadingKey } from './heading-key';

/** 通用章务标题停用词集合（简介/总结/Summary/引言...归一化后整名命中，不构成概念） */
export const NON_CONCEPT_HEADINGS = new Set([
  '简介', '引言', '前言', '序言', '序', '导语', '结语', '结尾', '总结', '小结', 
  '概述', '概览', '大纲', '目录', '附录', '后记', '致谢', '参考文献', '参考资料', 
  '习题', '练习', '思考题', '常见问题',
  'introduction', 'intro', 'preface', 'foreword', 'summary', 'conclusion', 
  'overview', 'outline', 'toc', 'table of contents', 'appendix', 'afterword', 
  'references', 'bibliography', 'resources', 'faq', 'exercises', 'exercise', 
  'getting started', 'credits'
]);

/** 单文档概念抽取上限（源头控熵：控制在 5 个以内，避免大仓概念节点爆炸） */
export const MAX_CONCEPTS_PER_DOC = 5;

export interface ExtractedConcept {
  conceptName: string;
  slug: string;
  category: 'architecture' | 'workflow' | 'principle' | 'reflection';
  principlesText: string;
  authorReflections?: string;
  sopSteps: string[];
  summary: string;
  subTopics: string[];
  tags: string[];
  /** 来源标题文本（反查 DocumentChunk 锚点的 key；无标题的概念块为 undefined，锚点跳过） */
  sourceHeading?: string;
  /** 概念块首条非空内容行（无标题/H1/H4+ 块无法按标题反查时的 General 块 content 匹配线索） */
  anchorText?: string;
}

/**
 * 为概念标题反查 chunk 锚点（纯函数，可单测）。
 * 匹配顺序：
 *  ① 精确：chunk.heading 归一化后 === 概念标题归一化（普通文档 chunk.heading = 叶子标题，见 chunker.ts chunkMarkdown）
 *  ② 后缀与分层叶子匹配：代码章节形如 "Chapter > Section" 或 "Chapter > 01_Section"，或包含长块切片 "(Part 1)"。
 *     切出末级叶子段单独归一化比对，支持带前缀的嵌套代码章节精准锚定（修复深审 P1 缺陷）。
 * 返回首个命中的 { id, headingPath }，未命中返回 null。
 */
export function matchChunkAnchor(
  chunks: { id: string; heading: string | null; headingPath: string | null }[],
  sourceHeading: string
): { id: string; headingPath: string | null } | null {
  const srcKey = normalizeHeadingKey(sourceHeading);
  if (!srcKey) return null;
  // ① 精确匹配（普通文档：chunk.heading = 叶子标题）
  const exact = chunks.find((c) => normalizeHeadingKey(c.heading || '') === srcKey);
  if (exact) return { id: exact.id, headingPath: exact.headingPath };

  // ② 后缀与分层叶子匹配（代码章节：CodeChunk heading = "Chapter > Section"，或长 chunk "Section (Part 1)"）
  const suffix = `> ${srcKey}`;
  const suff = chunks.find((c) => {
    if (!c.heading) return false;
    // 剥离大文档切片产生的 "(Part 1)" 后缀
    const cleanHeading = c.heading.replace(/\s*\(part\s*\d+\)$/i, '').trim();
    const norm = normalizeHeadingKey(cleanHeading);
    if (norm === srcKey || norm.endsWith(suffix)) return true;

    // 若包含分层路径 ">"，提取末尾叶子段单独归一化匹配（支持 "Chapter > 01_Section" 锚定到 "section"）
    if (cleanHeading.includes('>')) {
      const leaf = cleanHeading.split('>').pop() || '';
      if (normalizeHeadingKey(leaf) === srcKey) return true;
    }
    return false;
  });
  if (suff) return { id: suff.id, headingPath: suff.headingPath };
  return null;
}

export function slugifyConcept(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || `concept-${Date.now()}`;
}

export function extractConceptsFromMarkdown(
  markdownText: string,
  docPath: string
): ExtractedConcept[] {
  if (!markdownText || markdownText.trim().length === 0) return [];

  const concepts: ExtractedConcept[] = [];
  const lines = markdownText.split('\n');

  let currentHeading = '';
  let currentBlock: string[] = [];
  let currentBlockquotes: string[] = [];
  let currentSteps: string[] = [];
  let headinglessCount = 0; // 无标题块序号（合成名去重：同名会导致 slug 相同，upsert 互相覆盖丢概念）
  // 围栏状态机（与 chunker.ts chunkMarkdown 对齐）：``` / ~~~ 切换；
  // 围栏内 # 注释不当标题，避免代码注释（如 Python/Bash 的 #）变成垃圾概念节点
  let inCodeBlock = false;
  let codeFence = '';
  let currentHasCodeBlock = false;

  const flushConcept = () => {
    if (!currentHeading && currentBlock.length === 0) return;

    const fullBlockText = currentBlock.join('\n');
    // 无标题时 fallback 名称是合成值（i18n，"概述设计"/"Overview Notes"），无真实 chunk 可锚定 → sourceHeading 置空跳过反查
    const rawHeading = cleanMarkdownHeading(currentHeading);
    const hasRealHeading = rawHeading.length > 0;
    const dict = t();
    // 无标题块合成名按块序编号：第 1 个「概述设计」，后续「概述设计 2」…（防同名 slug 互相覆盖）
    const fallbackName = dict.untitledConceptName;
    const baseTitle = rawHeading || (headinglessCount === 0 ? fallbackName : `${fallbackName} ${headinglessCount + 1}`);
    const conceptTitle = baseTitle.slice(0, 60);
    if (!hasRealHeading) headinglessCount++;

    // 2. 通用章务标题停用词过滤（简介/总结/Summary/引言...归一化后整名命中停用词，不构成概念）
    const normTitle = normalizeHeadingKey(conceptTitle);
    const stopPatterns = MODULE_ROLE_PATTERNS?.conceptTitleStopPatterns;
    if (
      hasRealHeading &&
      (NON_CONCEPT_HEADINGS.has(normTitle) ||
        (Array.isArray(stopPatterns) && stopPatterns.some((re) => re.test(normTitle))))
    ) {
      currentBlock = [];
      currentBlockquotes = [];
      currentSteps = [];
      currentHasCodeBlock = false;
      return;
    }

    // 3. 纯空内容过滤：若标题下无任何正文内容（如连续多个空标题），跳过
    const trimmedBody = fullBlockText.trim();
    if (hasRealHeading && trimmedBody.length === 0) {
      currentBlock = [];
      currentBlockquotes = [];
      currentSteps = [];
      currentHasCodeBlock = false;
      return;
    }

    // 4. 低信息密度过渡块过滤：若既无代码块、无步骤、无反思引用，且正文字数极少（< 10 字），属过场文本，不构成认知概念
    if (
      hasRealHeading &&
      !currentHasCodeBlock &&
      currentSteps.length === 0 &&
      currentBlockquotes.length === 0 &&
      trimmedBody.length < 10
    ) {
      currentBlock = [];
      currentBlockquotes = [];
      currentSteps = [];
      currentHasCodeBlock = false;
      return;
    }

    // 锚点兜底线索：概念块首条非空内容行（反查 General 块 content 时匹配用）
    const anchorLine = currentBlock.find((l) => l.trim().length > 0);
    const anchorText = anchorLine ? anchorLine.trim().slice(0, 120) : undefined;

    // 作者反思提取：Markdown 引用块 (>) + 模式匹配（双语词表）
    const reflectionPatterns = MODULE_ROLE_PATTERNS?.conceptReflectionContentPatterns;
    const reflectionLines = currentBlockquotes.concat(
      Array.isArray(reflectionPatterns)
        ? currentBlock.filter((l) => reflectionPatterns.some((re) => re.test(l)))
        : []
    );
    const authorReflections = reflectionLines.length > 0
      ? reflectionLines.join('\n\n').slice(0, 1500)
      : undefined;

    // 分类判定：纯结构 AST（有序步骤、引用块、代码块）优先 + 集中注册表模式兜底
    const workflowPatterns = MODULE_ROLE_PATTERNS?.conceptWorkflowTitlePatterns;
    const principlePatterns = MODULE_ROLE_PATTERNS?.conceptPrincipleTitlePatterns;
    let category: 'architecture' | 'workflow' | 'principle' | 'reflection' = 'architecture';
    if (
      currentSteps.length > 0 ||
      (Array.isArray(workflowPatterns) && workflowPatterns.some((re) => re.test(conceptTitle)))
    ) {
      category = 'workflow';
    } else if (authorReflections) {
      category = 'reflection';
    } else if (
      currentHasCodeBlock ||
      (Array.isArray(principlePatterns) && principlePatterns.some((re) => re.test(conceptTitle))) ||
      trimmedBody.length > 300
    ) {
      category = 'principle';
    }

    concepts.push({
      conceptName: conceptTitle,
      slug: slugifyConcept(`${docPath}-${conceptTitle}`),
      category,
      principlesText: fullBlockText.slice(0, 2000),
      authorReflections,
      sopSteps: currentSteps.slice(0, 10),
      summary: fullBlockText.slice(0, 200).replace(/\n/g, ' '),
      subTopics: [category, dict.mentorGuidanceTag],
      tags: [dict.experienceTag, category],
      sourceHeading: hasRealHeading ? conceptTitle : undefined,
      anchorText,
    });

    currentBlock = [];
    currentBlockquotes = [];
    currentSteps = [];
    currentHasCodeBlock = false;
  };

  for (const line of lines) {
    // 围栏状态机（与 chunker.ts chunkMarkdown 对齐）：``` / ~~~ 切换
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fenceMatch[1];
        currentHasCodeBlock = true;
      } else if (fenceMatch[1][0] === codeFence[0] && fenceMatch[1].length >= codeFence.length && fenceMatch[2].trim() === '') {
        inCodeBlock = false;
      }
    }

    // 围栏内 # 行不当标题（代码注释），与切片器结构认知对齐，提升锚点命中率
    if (!inCodeBlock && line.startsWith('#')) {
      flushConcept();
      currentHeading = line;
    } else {
      currentBlock.push(line);
      // 围栏内的 > / Step 行也不做反思/步骤解析（避免代码内容污染）
      if (!inCodeBlock) {
        if (line.trim().startsWith('>')) {
          currentBlockquotes.push(line.trim().replace(/^>\s*/, ''));
        }
        const stepMatch = line.trim().match(/^(?:Step\s*\d+|\d+[\.\)]|Phase\s*\d+|步骤\s*\d+)\s*(.+)/i);
        if (stepMatch && stepMatch[1]) {
          currentSteps.push(stepMatch[1].trim());
        }
      }
    }
  }
  flushConcept();

  return concepts.slice(0, MAX_CONCEPTS_PER_DOC);
}

/**
 * 概念与 Chunk 锚点消歧匹配及 principlesText 丰富（与 Go ResolveConceptChunkAnchor / EnrichPrinciplesText 逐字对齐）。
 */
export function resolveConceptChunkAnchor(
  item: ExtractedConcept,
  chunks: Array<{ id: string; heading?: string | null; headingPath?: string | null; content: string }>
): { chunkId: string | null; headingPath: string | null; principlesText: string } {
  const normalizedChunks: Array<{ id: string; heading: string | null; headingPath: string | null; content: string }> = chunks.map((c) => ({
    id: c.id,
    heading: c.heading ?? null,
    headingPath: c.headingPath ?? null,
    content: c.content,
  }));
  const generalChunks = normalizedChunks.filter((c) => normalizeHeadingKey(c.heading || '') === 'general');
  let chunkId: string | null = null;
  let headingPath: string | null = null;

  if (item.sourceHeading) {
    const hit = matchChunkAnchor(normalizedChunks, item.sourceHeading);
    if (hit) {
      chunkId = hit.id;
      headingPath = hit.headingPath;
    }
  }
  if (!chunkId && item.conceptName) {
    const hit = matchChunkAnchor(normalizedChunks, item.conceptName);
    if (hit) {
      chunkId = hit.id;
      headingPath = hit.headingPath;
    }
  }
  if (!chunkId && item.anchorText) {
    const anchor = item.anchorText.slice(0, 60);
    const hit =
      generalChunks.find((c) => c.content.includes(anchor)) ||
      normalizedChunks.find((c) => c.content.includes(anchor)) ||
      null;
    if (hit) {
      chunkId = hit.id;
      headingPath = hit.headingPath;
    }
  }
  if (!chunkId && item.conceptName && item.conceptName.length >= 2) {
    const hit = normalizedChunks.find((c) => c.content.includes(item.conceptName)) || null;
    if (hit) {
      chunkId = hit.id;
      headingPath = hit.headingPath;
    }
  }

  // 丰富 principlesText：如果概念未携带长正文，但成功锚定到 chunk，则以 chunk 正文前 2000 字作为原文章节佐证
  let principlesText = item.principlesText;
  if (chunkId && (!principlesText || principlesText === item.summary)) {
    const matchedChunk = normalizedChunks.find((c) => c.id === chunkId);
    if (matchedChunk && matchedChunk.content) {
      principlesText = matchedChunk.content.slice(0, 2000);
    }
  }
  if (!principlesText) {
    principlesText = item.summary || item.conceptName;
  }

  return { chunkId, headingPath, principlesText };
}
