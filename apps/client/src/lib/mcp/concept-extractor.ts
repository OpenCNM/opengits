import { ConceptNodeItem } from '@/lib/mcp/concept-schemas';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';
import { normalizeHeadingKey } from './heading-key';
import { t } from '@/lib/i18n';

export { normalizeHeadingKey } from './heading-key';

export const NON_CONCEPT_HEADINGS = new Set([
  '简介', '引言', '前言', '序言', '序', '导语', '结语', '结尾', '总结', '小结', 
  '概述', '概览', '大纲', '目录', '附录', '后记', '致谢', '参考文献', '参考资料', 
  '习题', '练习', '思考题', '常见问题',
  'introduction', 'intro', 'preface', 'foreword', 'summary', 'conclusion', 
  'overview', 'outline', 'toc', 'table of contents', 'appendix', 'afterword', 
  'references', 'bibliography', 'resources', 'faq', 'exercises', 'exercise', 
  'getting started', 'credits'
]);

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
  sourceHeading?: string;
  anchorText?: string;
}

export function matchChunkAnchor(
  chunks: { id: string; heading: string | null; headingPath: string | null }[],
  sourceHeading: string
): { id: string; headingPath: string | null } | null {
  const srcKey = normalizeHeadingKey(sourceHeading);
  if (!srcKey) return null;
  const exact = chunks.find((c) => normalizeHeadingKey(c.heading || '') === srcKey);
  if (exact) return { id: exact.id, headingPath: exact.headingPath };

  const suffix = `> ${srcKey}`;
  const suff = chunks.find((c) => {
    if (!c.heading) return false;
    const cleanHeading = c.heading.replace(/\s*\(part\s*\d+\)$/i, '').trim();
    const norm = normalizeHeadingKey(cleanHeading);
    if (norm === srcKey || norm.endsWith(suffix)) return true;

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
  let headinglessCount = 0; // Number untitled blocks sequentially so identical fallback names do not collide on slug upsert.
  // Track fenced code blocks so `#` comments inside code are never treated as concept headings.
  let inCodeBlock = false;
  let codeFence = '';
  let currentHasCodeBlock = false;

  const flushConcept = () => {
    if (!currentHeading && currentBlock.length === 0) return;

    const fullBlockText = currentBlock.join('\n');
    const rawHeading = cleanMarkdownHeading(currentHeading);
    const hasRealHeading = rawHeading.length > 0;
    const dict = t();
    const fallbackName = dict.untitledConceptName;
    const baseTitle = rawHeading || (headinglessCount === 0 ? fallbackName : `${fallbackName} ${headinglessCount + 1}`);
    const conceptTitle = baseTitle.slice(0, 60);
    if (!hasRealHeading) headinglessCount++;

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

    const trimmedBody = fullBlockText.trim();
    if (hasRealHeading && trimmedBody.length === 0) {
      currentBlock = [];
      currentBlockquotes = [];
      currentSteps = [];
      currentHasCodeBlock = false;
      return;
    }

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

    const anchorLine = currentBlock.find((l) => l.trim().length > 0);
    const anchorText = anchorLine ? anchorLine.trim().slice(0, 120) : undefined;

    const reflectionPatterns = MODULE_ROLE_PATTERNS?.conceptReflectionContentPatterns;
    const reflectionLines = currentBlockquotes.concat(
      Array.isArray(reflectionPatterns)
        ? currentBlock.filter((l) => reflectionPatterns.some((re) => re.test(l)))
        : []
    );
    const authorReflections = reflectionLines.length > 0
      ? reflectionLines.join('\n\n').slice(0, 1500)
      : undefined;

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

    if (!inCodeBlock && line.startsWith('#')) {
      flushConcept();
      currentHeading = line;
    } else {
      currentBlock.push(line);
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
