import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { matchBlockedKeywords } from '@/lib/review/keyword-blocklist';
import { buildReviewFeedback } from '@/lib/review/platform-review';
import { REPORT_REASONS, REPORT_REASON_LABELS } from '@/lib/review/config';

const findUniqueRepoMock = vi.fn();
const findFirstReportMock = vi.fn();
const createReportMock = vi.fn();
const updateRepoMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: (...args: unknown[]) => findUniqueRepoMock(...args),
      findFirst: (...args: unknown[]) => findUniqueRepoMock(...args),
      update: (...args: unknown[]) => updateRepoMock(...args),
    },
    contentReport: {
      findFirst: (...args: unknown[]) => findFirstReportMock(...args),
      create: (...args: unknown[]) => createReportMock(...args),
    },
  },
}));

const checkRateLimitMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'reporter-1' } }),
}));

describe('M05 [5.4] 公开教程审核流与违规举报处置', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
    findUniqueRepoMock.mockResolvedValue({ id: 'repo-1', isPublic: true });
    findFirstReportMock.mockResolvedValue(null);
    createReportMock.mockResolvedValue({ id: 'report-1' });
  });

  // 🧪 [5.4.1.1 · HIGH] 利用低分但包含擦边违规内容的教程绕过初审
  // AntiPattern: 单一模型单次判定
  // DefenseAssertion: 必须同时满足安全评分 >= 85 且无违规关键词触发方可自动过审
  it('5.4.1.1 平台关键词零成本裸防线：严格识别违法违规内容，容忍度测试抵御零宽字符注入', () => {
    // 1. 明确违规内容直接命中
    const hit1 = matchBlockedKeywords(['本教程教你如何在 Linux 上搭建赌博网站与六合彩']);
    expect(hit1.length).toBeGreaterThan(0);
    expect(hit1[0].category).toBe('赌博');

    // 2. 暴力恐怖关键词拦截
    const hit2 = matchBlockedKeywords(['制造炸弹 详细化学配比与教程']);
    expect(hit2.length).toBeGreaterThan(0);
    expect(hit2[0].category).toBe('暴力恐怖');

    // 3. 零宽字符注入混淆攻击拦截（\u200B 零宽空格绕过）
    const obfuscated = '网络黑客\u200Bddos\u200D攻击\u2060教程与木马注入';
    const hitObfuscated = matchBlockedKeywords([obfuscated]);
    expect(hitObfuscated.length).toBeGreaterThan(0);
    expect(hitObfuscated[0].category).toBe('黑客攻击');

    // 4. 合法教学内容零误报
    const cleanContent = [
      'Next.js 15 App Router 全栈最佳实践',
      '详细讲解 React Server Components 与 Prisma 事务处理',
    ];
    const hitClean = matchBlockedKeywords(cleanContent);
    expect(hitClean).toHaveLength(0);
  });

  // 🧪 [5.4.2.1 · MEDIUM] 驳回理由回传中泄露管理员个人敏感信息或系统内部堆栈
  // AntiPattern: 直接将 Error.stack 暴露给前端
  // DefenseAssertion: 脱敏消毒，仅返回标准国际化审核驳回标签与整改建议
  it('5.4.2.1 驳回理由脱敏消毒：buildReviewFeedback 面向用户返回脱敏结构化整改指引，杜绝泄露系统细节', () => {
    // 场景 A: 命中关键词黑名单
    const feedbackKeyword = buildReviewFeedback({
      overallScore: 0,
      passed: false,
      confidence: 1,
      safetyFlag: true,
      dimensions: [],
      concerns: ['命中关键词黑名单（赌博）'],
      summary: '黑名单拦截',
      keywordHit: true,
    }, 'gpt-4o');

    expect(feedbackKeyword.reason).toBe('keyword_hit');
    expect(feedbackKeyword.guidance).toContain('内容命中平台内容安全黑名单');
    expect(feedbackKeyword.guidance).toContain('gpt-4o');
    expect(feedbackKeyword.guidance).not.toContain('stack');
    expect(feedbackKeyword.guidance).not.toContain('Error:');

    // 场景 B: 平台内部调用故障
    const feedbackError = buildReviewFeedback({
      overallScore: 0,
      passed: false,
      confidence: 0,
      safetyFlag: true,
      dimensions: [],
      concerns: ['内部服务超时: Connection timeout to 10.0.0.1:8080/v1/review at /secret/db.ts:42'],
      summary: '调用失败',
      failureReason: 'call_failed',
    });

    expect(feedbackError.reason).toBe('call_failed');
    expect(feedbackError.guidance).toBe('平台初审通道暂时不可用，本次发布已转人工审核队列，请耐心等待管理员审核。');
    expect(feedbackError.guidance).not.toContain('10.0.0.1');
    expect(feedbackError.guidance).not.toContain('db.ts');
  });

  // 🧪 [5.4.3.1 · HIGH] 恶意水军批量举报正常优质教程导致自动封禁
  // AntiPattern: 举报次数达到阈值直接触发自动下架
  // DefenseAssertion: 举报仅提升人工工单优先级，必须经管理员鉴权审批后方可执行下架
  it('5.4.3.1 举报防刷与不下架：举报进工单队列但绝不修改 isPublic，同人幂等去重与限流保护', async () => {
    const { POST } = await import('@/app/api/reports/route');

    // 1. 用户提交举报 -> 仅创建 contentReport，绝不触碰 repository.update (不修改 isPublic)
    const req1 = new NextRequest('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo-1',
        reason: 'MALICIOUS',
        detail: '涉嫌恶意违规内容',
      }),
    });

    const res1 = await POST(req1);
    expect(res1.status).toBe(200);
    expect(createReportMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositoryId: 'repo-1',
        reporterId: 'reporter-1',
        reason: 'MALICIOUS',
        detail: '涉嫌恶意违规内容',
      }),
    });
    // 关键防线：举报只写工单，绝不触发自动下架
    expect(updateRepoMock).not.toHaveBeenCalled();

    // 2. 同一用户重复提交未处理举报 -> 幂等去重返回 alreadyReported: true，不重复刷单
    findFirstReportMock.mockResolvedValueOnce({ id: 'existing-report-id' });
    const req2 = new NextRequest('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo-1',
        reason: 'MALICIOUS',
      }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.data.alreadyReported).toBe(true);

    // 3. 恶意脚本高频狂发 -> 触发 429 限流
    checkRateLimitMock.mockResolvedValueOnce(false);
    const req3 = new NextRequest('http://localhost/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo-1',
        reason: 'MALICIOUS',
      }),
    });
    const res3 = await POST(req3);
    expect(res3.status).toBe(429);
  });

  it('举报原因枚举与文案完整映射', () => {
    expect(REPORT_REASONS.length).toBeGreaterThan(0);
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason]).toBeDefined();
      expect(typeof REPORT_REASON_LABELS[reason]).toBe('string');
    }
  });
});
