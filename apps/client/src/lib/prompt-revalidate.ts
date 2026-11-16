/**
 * Prompt 热编辑跨进程即时生效通知：
 * admin 保存/回滚 prompt 后，client 进程的 PromptRegistry 内存缓存（10 分钟 TTL）
 * 必须经本通知主动清退，否则发布与线上行为存在最长 10 分钟的不一致窗口。
 *
 * 语义与 notifyClientRevalidate（publish-fanout）同构：
 * WEB_INTERNAL_URL/INTERNAL_API_TOKEN 未配置时静默跳过（10 分钟 TTL 兜底），
 * 通知失败仅留痕、绝不阻断保存/回滚本身。
 */
export async function notifyPromptRevalidate(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  const base = process.env.WEB_INTERNAL_URL;
  const token = process.env.INTERNAL_API_TOKEN;
  if (!base || !token) return false;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/internal/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ promptKeys: keys }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[prompt-revalidate] client prompt cache notify failed (10min TTL fallback applies):', err);
    return false;
  }
}
