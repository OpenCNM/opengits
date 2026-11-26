import type { PromptSchemaDefinition } from './prompt-registry';

// Guards critical output markers against accidental removal during admin hot-edits.
export const PROMPT_REQUIRED_MARKERS: Record<string, string[]> = {
  mdx_enhancer: ['===CONTENT_BEGIN===', '<pedagogy_manifest>'],
  mdx_enhance_localize: ['===CONTENT_BEGIN===', '<pedagogy_manifest>'],
  mdx_repair: ['===CONTENT_BEGIN==='],
};

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
