import { z } from 'zod';
import { generateStructured } from '@/lib/ai';
import { prisma } from '@/lib/db';
import { REPORT_REASON_LABELS, type ReportReason } from './config';
import { PromptRegistry } from '@/lib/prompt-registry';

/**
 * 举报 LLM 分诊：批量对未处理举报分类严重度（admin 队列按 high > medium > low 排序）。
 * 失败策略：LLM 不可用/超时 → 返回空数组（跳过分诊，队列按时间序），绝不阻塞 admin 访问。
 */

const triageSchema = z.object({
  reportId: z.string().describe('The report id this verdict belongs to (copy exactly)'),
  severity: z.enum(['high', 'medium', 'low']).describe('high=plausible infringement/harmful content needing prompt takedown; medium=quality/degraded content; low=likely noise or disagreement'),
  comment: z.string().describe('One-sentence Chinese note for the admin explaining the severity'),
});

export interface ReportTriageInput {
  reportId: string;
  reason: string;
  detail: string | null;
  repoRef: string;
}

export interface ReportTriageVerdict {
  reportId: string;
  severity: 'high' | 'medium' | 'low';
  comment: string;
}

export async function triageReports(reports: ReportTriageInput[], adminUserId?: string): Promise<ReportTriageVerdict[]> {
  if (reports.length === 0) return [];
  try {
    const { resolveActiveUserModel, toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    const userModel = await resolveActiveUserModel(adminUserId).catch(() => null);
    const injectable = toInjectableStructuredModel(userModel);
    if (!injectable) return [];

    const reportsList = reports
      .map(
        (r) =>
          `- id=${r.reportId} | repo=${r.repoRef} | reason=${REPORT_REASON_LABELS[r.reason as ReportReason] || r.reason} | detail=${r.detail || '(none)'}`
      )
      .join('\n');

    const compiled = await PromptRegistry.getCompiledPrompt('report_triage_judge', {
      reportsList,
    });

    const result = await generateStructured({
      model: injectable,
      userId: adminUserId,
      schema: z.object({ verdicts: z.array(triageSchema).min(1) }),
      prompt: compiled.compiledPrompt,
    });

    const verdicts = result.object.verdicts
      .filter((v) => reports.some((r) => r.reportId === v.reportId))
      .map((v) => ({ reportId: v.reportId, severity: v.severity, comment: v.comment }));

    // 持久化分诊结果（失败不阻塞返回）
    for (const v of verdicts) {
      await prisma.contentReport
        .update({
          where: { id: v.reportId },
          data: { triage: v as unknown as import('@prisma/client').Prisma.InputJsonValue },
        })
        .catch(() => {});
    }
    return verdicts;
  } catch (err) {
    console.warn('[report-triage] LLM unavailable, skipping triage:', err instanceof Error ? err.message : err);
    return [];
  }
}
