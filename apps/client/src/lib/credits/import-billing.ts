// 导入计费口径（结算的唯一事实源）。
//
// 历史缺陷（B1/B2/B3）：
// - 估算基数取 draftOutline.length —— 那是大纲的「分类/模块数」而非文档数
//   （5 分类 × 100 篇的仓按 5 计价），结算又被 min(frozen, actual) 反向钳死，
//   大仓系统性少付；且 code_pedagogy 判定在路由与结算两处口径漂移；
//   字符基准 1500 内联硬编码，admin 的 standardChunkCharSize 配置形同虚设。
//
// 本模块收敛为单一函数族：结算诚实计费不被冻结额钳制；code_pedagogy 判定
// 双端共用本函数。入场估算（estimateImportBilling/billableDocCountFromOutline）
// 随提交期积分准入退役删除（2026-11 收口）——Go settle 按实际处理章节数结算。
//

import { estimateRequiredCredits } from '@/lib/credits-config';
import type { DynamicCreditsConfig } from '@/lib/credits-config';

/**
 * code_pedagogy 判定的唯一口径（B2 修复）：估算与结算必须共用本函数，
 * 禁止在路由 / runner 各自内联。
 */
export function isCodePedagogyBilling(params: {
  teachingDepth?: string | null;
  ingestMode?: string | null;
}): boolean {
  return Boolean(
    (params.teachingDepth && params.teachingDepth !== 'overview') ||
      params.ingestMode === 'code_only'
  );
}

/**
 * 导入结算（Node 发奖回调用）：真实入队文档数诚实计费（B1 的另一半——去掉
 * min(frozen, actual) 钳制；入场预检已经管住了上限，结算如实反映规模）。
 * 冻结额与实际消耗的差值自然表现为「多冻结少实扣」（退还）或「实报实销」。
 */
export function settleImportBilling(params: {
  actualDocCount: number;
  /** Server-read real content, counted as Unicode code points. Missing content earns nothing. */
  actualChars?: number;
  isPublic: boolean;
  teachingDepth?: string | null;
  ingestMode?: string | null;
  config: DynamicCreditsConfig;
}): ReturnType<typeof estimateRequiredCredits> {
  const chars = params.actualChars ?? 0;
  const chunks = Number.isSafeInteger(chars) && chars > 0
    ? Math.ceil(chars / Math.max(1, params.config.standardChunkCharSize)) : 0;
  const multiplier = isCodePedagogyBilling(params) ? params.config.codePedagogyMultiplier : 1;
  const baseCredits = Math.ceil(chunks * multiplier);
  const cap = Math.max(0, params.config.maxCreditsPerImport);
  return {
    estimatedChunks: chunks,
    baseCredits,
    finalCredits: 0,
    rewardCredits: params.isPublic ? Math.min(baseCredits, cap) : 0,
    discountApplied: params.isPublic,
  };
}
