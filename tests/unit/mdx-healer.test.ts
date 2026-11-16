import { test, expect } from 'vitest';

/**
 * mdx-healer（2026-09-11 收刀）：localHealMdxSource 已物理删除，契约由冻结夹具
 * mdx-healer.golden.json 在 Go 端锁定——本文件仅覆盖 Fail-Closed 语义。
 */
test('sidecar 离线时 healMdxSource 显式抛 SidecarError（无本地回退）', async () => {
  delete process.env.INTERNAL_API_TOKEN;
  delete process.env.WORKER_SIDECAR_URL;
  await expect(healMdxSourceImported()).rejects.toThrow(/sidecar unreachable|not configured/);
});

async function healMdxSourceImported(): Promise<string> {
  const { healMdxSource } = await import('@/lib/mdx/ast-healer');
  return healMdxSource('# 标题 {漏括号}');
}
