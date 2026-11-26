import { callSidecar } from '../sidecar-client';

export interface HealMdxOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Layer 2 sidecar AST healing runs only after Layer 1 MDX compilation fails; fails closed on sidecar outage.
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

