import { z } from 'zod';
import { MONITOR_EVENT_KINDS } from './events';

/**
 * /api/monitor 网关的 Frame-1 fail-fast 契约：
 * 逐 kind discriminated union 严格校验，shape 漂移在第一帧暴露并丢弃，
 * 绝不带病转发到 Go 单写者。字符串/数值上限与采集器截断值双侧一致（双保险）。
 */

// 字段上限常量（与采集器 collector.ts 截断值同步；库内多 schema 复用故集中声明）
const MESSAGE_MAX = 2000;
const STACK_MAX = 8000;
const URL_MAX = 500;
const VITAL_MAX_MS = 600_000; // 10 分钟：超过即视为客户端时钟异常，拒绝入库

const messageSchema = z.string().min(1).max(MESSAGE_MAX);
const stackSchema = z.string().max(STACK_MAX);
const urlSchema = z.string().min(1).max(URL_MAX);
const sessionIdSchema = z.string().min(1).max(64);
const severitySchema = z.enum(['long', 'severe']);

const baseShape = {
  pageUrl: urlSchema,
  sessionId: sessionIdSchema,
} as const;

export const monitorEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.SESSION_START),
    ...baseShape,
    payload: z.object({ userAgent: z.string().min(1).max(500) }).optional(),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.SESSION_END),
    ...baseShape,
    payload: z.object({ reason: z.literal('pagehide') }).optional(),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.CRASH_INFERRED),
    ...baseShape,
    payload: z.object({
      previousSessionId: z.string().min(1).max(64),
      lastedMs: z.number().int().min(0).max(86_400_000), // 24h 上限：异常时钟防线
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.JS_ERROR),
    ...baseShape,
    payload: z.object({
      message: messageSchema,
      stack: stackSchema.optional(),
      source: z.string().max(URL_MAX).optional(),
      line: z.number().int().nonnegative().optional(),
      col: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.RESOURCE_ERROR),
    ...baseShape,
    payload: z.object({
      tagName: z.string().min(1).max(32),
      url: z.string().max(URL_MAX),
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.PROMISE_REJECTION),
    ...baseShape,
    payload: z.object({
      message: messageSchema,
      stack: stackSchema.optional(),
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.RENDER_ERROR),
    ...baseShape,
    payload: z.object({
      message: messageSchema,
      digest: z.string().max(128).optional(),
      stack: stackSchema.optional(),
      boundary: z.enum(['route', 'global']),
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.FREEZE),
    ...baseShape,
    severity: severitySchema,
    payload: z.object({
      durationMs: z.number().int().min(50).max(VITAL_MAX_MS),
      attribution: z.string().max(URL_MAX).optional(),
    }),
  }),
  z.object({
    kind: z.literal(MONITOR_EVENT_KINDS.WEB_VITALS),
    ...baseShape,
    payload: z.object({
      lcpMs: z.number().nonnegative().max(VITAL_MAX_MS).optional(),
      inpMs: z.number().nonnegative().max(VITAL_MAX_MS).optional(),
      cls: z.number().nonnegative().max(100).optional(),
      ttfbMs: z.number().nonnegative().max(VITAL_MAX_MS).optional(),
      fcpMs: z.number().nonnegative().max(VITAL_MAX_MS).optional(),
    }),
  }),
]);

export const monitorBatchSchema = z.object({
  events: z.array(monitorEventSchema).min(1).max(50),
});

export type MonitorEventInput = z.infer<typeof monitorEventSchema>;
