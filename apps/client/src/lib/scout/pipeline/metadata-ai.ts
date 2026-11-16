/**
 * 探测阶段元数据兜底值。
 *
 * 分类/打标不再由探测链产出（scout_outline_draft 伴生产出已退役）——探测阶段保持
 * 零 LLM、零推断，未分类（Others/空 tags）是预期状态：导入完成后由
 * /api/scout/repo-metadata 懒取端点（repo-metadata-classifier）一次性补全，入库侧归一落库。
 */
export interface ScoutMetadata {
  aiCategory: string;
  aiTags: string;
  paradigm: string;
  parallelTracks: string[];
}

export const DEFAULT_METADATA: ScoutMetadata = {
  aiCategory: 'Others',
  aiTags: '',
  paradigm: 'Engineering',
  parallelTracks: [],
};
