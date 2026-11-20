import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────
 * tree-outline-driver SSE error 事件透传契约（最后一跳承重墙）。
 *
 * round-2 交叉验收指认的零测试承重点：Go sendPipelineError 的结构化
 * {message, code, status} SSE 帧经 parseSSEStream 解析后，code/status
 * 必须附加到抛出的 Error 上——ImportWorkbench 的密钥错误卡与重配按钮
 * 全部依赖这两个字段，字段丢失 = 端到端收口断链。
 * ─────────────────────────────────────────────────────────────
 */
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: vi.fn(),
  callSidecarStream: vi.fn(),
}));

import { executeSidecarTreeOutline } from '@/engine/tree-outline-driver';
import { callSidecarStream } from '@/lib/sidecar-client';

const sseResponse = (frames: string): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

describe('tree-outline-driver SSE error 透传', () => {
  beforeEach(() => {
    vi.mocked(callSidecarStream).mockReset();
  });

  it('密钥类错误帧：code/status 附加到抛出的 Error（KEY_DECRYPT_FAILED 409）', async () => {
    const frame =
      'event: error\ndata: ' +
      JSON.stringify({ message: '云端已保存的 AI 密钥无法解密', code: 'KEY_DECRYPT_FAILED', status: 409 }) +
      '\n\n';
    vi.mocked(callSidecarStream).mockResolvedValue(sseResponse(frame));

    const err = await executeSidecarTreeOutline(
      { owner: 'o', repo: 'r', sha: 'abc', userId: 'u1' },
      { stream: true }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe('KEY_DECRYPT_FAILED');
    expect((err as Error & { status?: number }).status).toBe(409);
    expect((err as Error).message).toContain('无法解密');
  });

  it('MISSING_API_KEY 帧：code 同样透传（区分根因不混淆）', async () => {
    const frame =
      'event: error\ndata: ' +
      JSON.stringify({ message: '未配置 API Key', code: 'MISSING_API_KEY', status: 409 }) +
      '\n\n';
    vi.mocked(callSidecarStream).mockResolvedValue(sseResponse(frame));

    const err = await executeSidecarTreeOutline(
      { owner: 'o', repo: 'r', sha: 'abc', userId: 'u1' },
      { stream: true }
    ).catch((e: unknown) => e);
    expect((err as Error & { code?: string }).code).toBe('MISSING_API_KEY');
  });

  it('无 code 的旧二进制错误帧：仅透传 message（降级形态安全）', async () => {
    const frame =
      'event: error\ndata: ' + JSON.stringify({ message: 'outline failed: boom', status: 500 }) + '\n\n';
    vi.mocked(callSidecarStream).mockResolvedValue(sseResponse(frame));

    const err = await executeSidecarTreeOutline(
      { owner: 'o', repo: 'r', sha: 'abc', userId: 'u1' },
      { stream: true }
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe('outline failed: boom');
    expect((err as Error & { code?: string }).code).toBeUndefined();
  });
});
