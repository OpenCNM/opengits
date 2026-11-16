import type { PromptSchemaDefinition } from './prompt-registry';

/**
 * Prompt 契约护栏（Phase 2-lite）：
 * 部分 key 的 prompt 内嵌与确定性管线（Go stripper 哨兵抽取 / Stage 3）耦合的输出契约标记，
 * 后台热编辑误删标记会导致收敛漏斗静默降级。保存/回滚前必须通过本注册表的标记校验。
 * 未登记的 key 自由编辑不受影响。
 */
export const PROMPT_REQUIRED_MARKERS: Record<string, string[]> = {
  // 实证依据 prompt-presets.ts（OUTPUT FORMAT: ===CONTENT_BEGIN=== 指令）：
  mdx_enhancer: ['===CONTENT_BEGIN===', '<pedagogy_manifest>'],
  mdx_enhance_localize: ['===CONTENT_BEGIN===', '<pedagogy_manifest>'],
  mdx_repair: ['===CONTENT_BEGIN==='],
  // <pedagogy_manifest>：CONCEPT_MANIFEST_PROMPT_INSTRUCTION 内嵌于 mdx_enhancer/_localize 的
  // taskDescription——删除将静默丢失概念/测验提取（ExtractConceptManifest 依赖该 XML 块）。
};

/**
 * 校验 prompt schema 是否保留该 key 的必需契约标记。
 * @returns 违例描述数组；空数组 = 通过（含未登记 key）
 */
export function validatePromptContract(
  key: string,
  schema: PromptSchemaDefinition
): string[] {
  const markers = PROMPT_REQUIRED_MARKERS[key];
  if (!markers || markers.length === 0) return [];

  const fullText = [schema.taskDescription ?? '', ...(schema.rules ?? [])].join('\n');
  const violations: string[] = [];
  for (const marker of markers) {
    if (!fullText.includes(marker)) {
      violations.push(
        `${key} 的 prompt 必须保留输出契约标记 "${marker}"（确定性收敛管线依赖它解析载荷，删除将导致内容处理降级）`
      );
    }
  }
  return violations;
}
