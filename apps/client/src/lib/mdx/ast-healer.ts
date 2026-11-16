import { callSidecar } from '../sidecar-client';

export interface HealMdxOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Layer 2 AST-Aware Self-Healing Pass.
 * Executed ONLY if Layer 1 MDX compilation fails.
 * 调用 Go worker-sidecar /v1/mdx/heal 进行微秒级语法自愈（单实现）；
 * Sidecar 故障显式抛 SidecarError（Fail-Closed，本地 TS 双轨已物理删除）。
 * Strictly preserves code blocks and inline code snippets.
 */
export async function healMdxSource(rawMdx: string, options?: HealMdxOptions): Promise<string> {
  if (!rawMdx) return '';

  const remote = await callSidecar<{ ok: boolean; content: string }>(
    '/v1/mdx/heal',
    { content: rawMdx },
    { label: 'mdx-healer /v1/mdx/heal', ...options }
  );

  if (!remote.ok || typeof remote.content !== 'string') {
    throw new Error('mdx-healer /v1/mdx/heal: malformed content payload');
  }
  return remote.content;
}

