import type { NextRequest } from 'next/server';

/**
 * 请求体 JSON 单次解析缓存（WeakMap 按 Request 实例键控）。
 *
 * MCP 请求链上 guard（读 method）、normalizer（读工具名）、路由（读完整 body）
 * 各自 clone().json() 会重复解析同一请求体 2~3 次；大 arguments 体（dissect_code
 * 携带源码段）重复解析成本可测。经本助手读取过的 body 在同一 Request 实例上
 * 只解析一次，Promise 结果共享（含失败 null 兜底）。
 *
 * normalizer 重写请求时构造新的 NextRequest——新实例天然走独立缓存键，
 * 语义正确。
 */
const bodyJsonCache = new WeakMap<Request, Promise<any>>();

export function readBodyJson(request: NextRequest | Request): Promise<any> {
  let parsed = bodyJsonCache.get(request);
  if (!parsed) {
    parsed = request.clone().json().catch(() => null);
    bodyJsonCache.set(request, parsed);
  }
  return parsed;
}
