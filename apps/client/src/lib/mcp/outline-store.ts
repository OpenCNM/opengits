import { callSidecar } from '@/lib/sidecar-client';
import { OutlineDraft } from './ingest-orchestrator';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';

/**
 * ─────────────────────────────────────────────────────────────
 * 大纲存储 (Outline Store)
 *
 * 把编排器产出的 OutlineDraft 存入 TutorialOutline 编排层
 * (节→章→大类,REPO_INGEST_REDESIGN §10)。
 *
 * 编排可逆的数据基础:只动编排层(TutorialOutline/Part/Chapter/Node),
 * 内容层(Document/DocumentChunk)零改动。重新编排 = 新版本,旧版本可保留回滚。
 *
 * 零物化去耦合升级（Zero-Materialization）：
 * 确立 TutorialOutline 为唯一持久化源，读侧通过纯函数 projectNavTreeFromOutline
 * 实时投影；activateOutline 仅原子更新 TutorialOutline.isActive，彻底解绑 Repository 行锁与双写。
 * ─────────────────────────────────────────────────────────────
 */

export interface StoreOutlineDraftOptions {
  isActive?: boolean;
}

/**
 * 存储编排大纲到 DB。
 * 两步创建(Chapter.partId 需要 Part 的 id,不能纯嵌套):
 *   1. create Outline + Parts(嵌套)→ 拿 partId 映射
 *   2. 查 Documents(path → id)→ 遍历 chapters 创建 Chapter + Nodes
 *
 * @param repositoryId 仓库 ID
 * @param draft        编排器产出的大纲
 * @param opts.isActive 是否激活(影子模式默认 false;Phase 3 正式接管时 true)
 * @returns 创建的 outline.id
 */
export async function storeOutlineDraft(
  repositoryId: string,
  draft: OutlineDraft,
  opts?: StoreOutlineDraftOptions,
): Promise<string> {
  const res = await callSidecar<{ ok: boolean; outlineId: string }>(
    '/v1/outlines/draft/store',
    {
      repositoryId,
      draft,
      isActive: opts?.isActive ?? false,
    },
    { label: 'store outline draft' }
  );

  if (opts?.isActive ?? false) {
    invalidateWebL1Projection(repositoryId);
  }

  return res.outlineId;
}

/**
 * 切换激活大纲:同仓库只保留一个 isActive。
 * 编排可逆(REPO_INGEST_REDESIGN §10.6)= 秒级切换/回滚,内容层零改动。
 * 零物化：仅原子更新 TutorialOutline.isActive，解绑 Repository 行锁，读侧通过纯函数 projectNavTreeFromOutline 实时投影。
 */
export async function activateOutline(
  repositoryId: string,
  outlineId: string,
): Promise<void> {
  await callSidecar(
    '/v1/outlines/activate',
    { repositoryId, outlineId },
    { label: 'activate outline' }
  );

  // 主动清退 Web 端 L1 内存大纲投影
  invalidateWebL1Projection(repositoryId);
}

/**
 * 撤销仓库所有激活大纲 → 渲染回退 navTree。
 * 用于管理员手动回滚（reoutline 工具的 deactivate 动作）与派生异常仓。
 */
export async function deactivateAllOutlines(
  repositoryId: string,
): Promise<void> {
  await callSidecar(
    '/v1/outlines/deactivate',
    { repositoryId },
    { label: 'deactivate all outlines' }
  );

  // 主动清退 Web 端 L1 内存大纲投影
  invalidateWebL1Projection(repositoryId);
}
