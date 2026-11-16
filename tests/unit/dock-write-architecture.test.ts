import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Arch 守卫：Dock 写权限物理隔离。
 * `addOrUpdateTutorial` 是 TranscriptionDock 的唯一写入口，调用权仅限
 * `lib/stores/dock-sync.ts`（facade）与 store 自身定义处。任何新写入方
 * 必须经由 facade，杜绝写路径重新散落（零破窗守卫）。
 */

const CLIENT_SRC_ROOT = join(__dirname, '../../apps/client/src');
const ALLOWED_FILES = new Set([
  'lib/stores/transcription-dock-store.ts', // 定义处
  'lib/stores/dock-sync.ts', // 唯一写 facade
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Dock 写入架构守卫（addOrUpdateTutorial 调用权隔离）', () => {
  it('全仓仅 dock-sync facade 与 store 定义处引用 addOrUpdateTutorial', () => {
    const violators: string[] = [];
    for (const file of walk(CLIENT_SRC_ROOT)) {
      const rel = relative(CLIENT_SRC_ROOT, file).split('\\').join('/');
      if (ALLOWED_FILES.has(rel)) continue;
      const content = readFileSync(file, 'utf8');
      if (content.includes('addOrUpdateTutorial')) {
        violators.push(rel);
      }
    }
    expect(violators).toEqual([]);
  });
});
