import fs from 'fs-extra';
import path from 'path';
import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { getStorageDriver } from './driver';
import { getAssetsRootDir, getRepoAssetsDir } from './assets-paths';
import { activeStorageDriverName, assetObjectKey } from './assets-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const ASSETS_KEY_ROOT = 'assets/';

// Fail-safe to dry-run unless explicitly disabled so unconfigured deploys never purge assets.
function readDryRunDefault(): boolean {
  return process.env.ASSETS_GC_DRY_RUN !== 'false';
}

function readGraceDaysDefault(): number {
  return Number(process.env.ASSETS_ORPHAN_GRACE_DAYS) || 7;
}

function readPruneDeferMs(): number {
  return Number(process.env.ASSETS_PRUNE_DEFER_MS) || 60_000;
}

// Defer pruning and re-query DB ownership so re-imports never delete concurrently restored assets.
export function maybePruneRepoAssetDir(owner: string, repo: string): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const remaining = await prisma.repository.count({ where: { owner, repo } });
        if (remaining > 0) return;

        if (activeStorageDriverName() === 'local') {
          if (!(await fs.pathExists(getRepoAssetsDir(owner, repo)))) return;
          await fs.remove(getRepoAssetsDir(owner, repo));
        } else {
          const prefix = assetObjectKey(owner, repo, '');
          const objects = await getStorageDriver().listUnder(prefix);
          if (objects.length > 0) {
            await getStorageDriver().deleteMany(objects.map((o) => o.key));
          }
        }
      } catch {
        ignoreBestEffort();
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

// Reentrancy guard prevents overlapping cron ticks from racing the same orphan directories.
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
          if (active.has(`${owner}/${repo}`)) continue;
          if (Date.now() - st.mtimeMs <= cutoffAge) {
            report.skippedByGrace += 1;
            continue;
          }
          if (!dryRun) {
            try {
              await fs.remove(repoDir);
              report.removedDirs += 1;
            } catch {
            }
          } else {
            report.removedDirs += 1;
          }
        }
      }
    } else {
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
            ignoreBestEffort();
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
