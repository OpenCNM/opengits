import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { getStorageDriver } from './driver';
import { getAssetsRootDir, getRepoAssetsDir } from './assets-paths';
import { activeStorageDriverName, assetObjectKey } from './assets-store';

/**
 * ─────────────────────────────────────────────────────────────
 * assets 引用 GC（Phase 0 T6 / Phase 1 T6b 驱动化）。
 *
 * - maybePruneRepoAssetDir：删除讲法/仓后即时回收——延迟双检（TOCTOU 缓解）：
 *   defer 窗口后复查 DB 讲法行数，>0 取消（新讲法可能正在写入同目录）。
 * - sweepOrphanAssetDirs：每日孤儿清扫（挂 prune 调度器同轮）——
 *   local 分支走文件系统目录树；非 local 分支按对象前缀聚合整组回收。
 *
 * env 开关全部在调用时读取（ASSETS_GC_DRY_RUN / ASSETS_ORPHAN_GRACE_DAYS /
 * ASSETS_PRUNE_DEFER_MS，默认值与 ENGINE_CONFIG.storage 一致），
 * 默认 dry-run 只统计——真删需显式 ASSETS_GC_DRY_RUN=false。
 * ─────────────────────────────────────────────────────────────
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** 对象键根前缀（与 assetObjectKey 布局同构；此模块自持以防循环依赖） */
const ASSETS_KEY_ROOT = 'assets/';

function readDryRunDefault(): boolean {
  return process.env.ASSETS_GC_DRY_RUN !== 'false';
}

function readGraceDaysDefault(): number {
  return Number(process.env.ASSETS_ORPHAN_GRACE_DAYS) || 7;
}

function readPruneDeferMs(): number {
  return Number(process.env.ASSETS_PRUNE_DEFER_MS) || 60_000;
}

/**
 * 删除讲法/仓后的即时回收（fire-and-forget，调用方不 await）。
 * 失败静默——资产回收是尽力而为的清理，绝不阻断主流程。
 */
export function maybePruneRepoAssetDir(owner: string, repo: string): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        // 延迟双检：defer 窗口内可能有新讲法落行复用同目录
        const remaining = await prisma.repository.count({ where: { owner, repo } });
        if (remaining > 0) return;

        if (activeStorageDriverName() === 'local') {
          if (!(await fs.pathExists(getRepoAssetsDir(owner, repo)))) return;
          await fs.remove(getRepoAssetsDir(owner, repo));
        } else {
          // 对象存储：整前缀列出后批量删除
          const prefix = assetObjectKey(owner, repo, '');
          const objects = await getStorageDriver().listUnder(prefix);
          if (objects.length > 0) {
            await getStorageDriver().deleteMany(objects.map((o) => o.key));
          }
        }
      } catch {
        // 静默：清扫失败留给下一轮孤儿 sweep 兜底
      }
    })();
  }, readPruneDeferMs());
  timer.unref?.();
}

export interface SweepReport {
  dryRun: boolean;
  scannedDirs: number;
  removedDirs: number;
  skippedByGrace: number;
}

/** 互斥：清扫轮内不允许重入（调度器与手动触发并发时直接返回空报告） */
let sweeping = false;

export async function sweepOrphanAssetDirs(opts?: {
  dryRun?: boolean;
  graceDays?: number;
}): Promise<SweepReport> {
  const dryRun = opts?.dryRun ?? readDryRunDefault();
  const graceDays = opts?.graceDays ?? readGraceDaysDefault();
  const report: SweepReport = { dryRun, scannedDirs: 0, removedDirs: 0, skippedByGrace: 0 };
  if (sweeping) return report;
  sweeping = true;

  try {
    const activeRows = await prisma.repository.findMany({ select: { owner: true, repo: true } });
    const active = new Set(activeRows.map((r) => `${r.owner}/${r.repo}`));
    const cutoffAge = graceDays * DAY_MS;

    if (activeStorageDriverName() === 'local') {
      // local：文件系统两层目录树（owner → repo）
      const root = getAssetsRootDir();
      const owners = await fs.readdir(root).catch(() => [] as string[]);
      for (const owner of owners) {
        const ownerDir = path.join(root, owner);
        let ownerStat: { isDirectory(): boolean };
        try {
          ownerStat = await fs.stat(ownerDir);
        } catch {
          continue;
        }
        if (!ownerStat.isDirectory()) continue;

        const repos = await fs.readdir(ownerDir).catch(() => [] as string[]);
        for (const repo of repos) {
          const repoDir = path.join(ownerDir, repo);
          let st: { isDirectory(): boolean; mtimeMs: number };
          try {
            st = await fs.stat(repoDir);
          } catch {
            continue;
          }
          if (!st.isDirectory()) continue;

          report.scannedDirs += 1;
          if (active.has(`${owner}/${repo}`)) continue; // 活跃仓整体跳过
          if (Date.now() - st.mtimeMs <= cutoffAge) {
            report.skippedByGrace += 1;
            continue;
          }
          if (!dryRun) {
            try {
              await fs.remove(repoDir);
              report.removedDirs += 1;
            } catch {
              // 单目录失败不中断整轮
            }
          } else {
            report.removedDirs += 1; // dry-run：统计"将删除"
          }
        }
      }
    } else {
      // 对象存储：按 assets/{owner}/{repo} 前缀聚合整组判定
      const objects = await getStorageDriver().listUnder(ASSETS_KEY_ROOT);
      const groups = new Map<string, { keys: string[]; newest: number }>();
      for (const obj of objects) {
        const segs = obj.key.split('/');
        if (segs.length < 3) continue;
        const groupKey = segs.slice(0, 3).join('/');
        const g = groups.get(groupKey) ?? { keys: [], newest: 0 };
        g.keys.push(obj.key);
        g.newest = Math.max(g.newest, obj.lastModified.getTime());
        groups.set(groupKey, g);
      }

      for (const [groupKey, g] of groups) {
        report.scannedDirs += 1;
        const [, owner, repo] = groupKey.split('/');
        if (active.has(`${owner}/${repo}`)) continue;
        if (Date.now() - g.newest <= cutoffAge) {
          report.skippedByGrace += 1;
          continue;
        }
        if (!dryRun) {
          try {
            await getStorageDriver().deleteMany(g.keys);
            report.removedDirs += 1;
          } catch {
            // 单组失败不中断整轮
          }
        } else {
          report.removedDirs += 1;
        }
      }
    }
  } finally {
    sweeping = false;
  }

  return report;
}
