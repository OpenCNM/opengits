import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import { generateStructured } from '@/lib/ai';
import { prisma } from '@/lib/db';
import { REPORT_REASON_LABELS, type ReportReason } from './config';
import { PromptRegistry } from '@/lib/prompt-registry';

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
    const userModel = await resolveActiveUserModel(adminUserId).catch(() => { ignoreBestEffort(); return null; });
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

    for (const v of verdicts) {
      await prisma.contentReport
        .update({
          where: { id: v.reportId },
          data: { triage: v as unknown as import('@prisma/client').Prisma.InputJsonValue },
        })
        .catch(ignoreBestEffort);
    }
    return verdicts;
  } catch (err) {
    console.warn('[report-triage] LLM unavailable, skipping triage:', err instanceof Error ? err.message : err);
    return [];
  }
}
