import fs from 'fs-extra';
import { stat } from 'node:fs/promises';
import path from 'path';

/**
 * ─────────────────────────────────────────────────────────────
 * StorageDriver 抽象（Phase 1 T6：assets 存取收敛，key 同构历史目录）。
 *
 * key 语义：storage 根的相对路径，正斜杠分隔（local 落盘 / s3 对象键同构，
 * mc mirror 可直迁）。本文件只含 local 实现与工厂；s3 由 driver-s3.ts
 * 在 STORAGE_DRIVER=s3 时动态 import 注册（注册后工厂才会真正切换）。
 * 模块加载零副作用——测试需 importOriginal 无害加载。
 * ─────────────────────────────────────────────────────────────
 */

export interface StorageObjectStat {
  key: string;
  lastModified: Date;
}

export interface StorageDriver {
  name: 'local' | 's3';
  /** 读对象；不存在或 key 指向目录时返回 null（非 reject） */
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** 列出前缀下全部对象（local 递归目录 / s3 ListObjectsV2 分页聚合） */
  listUnder(prefix: string): Promise<StorageObjectStat[]>;
  deleteMany(keys: string[]): Promise<void>;
}

const LOCAL_ROOT = () => path.join(process.cwd(), 'storage');

/** key 校验：拒绝绝对路径、盘符、反斜杠与 `..`/空段（穿越防护）；两种驱动共用同一契约 */
export function assertValidKey(key: string): void {
  const invalid =
    !key ||
    key.includes('\\') ||
    key.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(key) ||
    key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (invalid) throw new Error(`invalid key: ${JSON.stringify(key)}`);
}

/** 前缀校验（listUnder 用）：S3 惯例允许尾斜杠（如 assets/o/r/），剥掉后按 key 校验 */
export function assertValidPrefix(prefix: string): void {
  assertValidKey(prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
}

function keyToLocalPath(key: string): string {
  return path.join(LOCAL_ROOT(), ...key.split('/'));
}

const localDriver: StorageDriver = {
  name: 'local',

  async get(key) {
    assertValidKey(key);
    const target = keyToLocalPath(key);
    // node:fs/promises 的 stat 带 Stats 完整类型（fs-extra 的 stat 重载ReturnType 退化为 void）
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(target);
    } catch {
      return null; // 不存在（含 ENOENT）一律 null
    }
    if (st.isDirectory()) return null;
    return fs.readFile(target);
  },

  async put(key, data) {
    assertValidKey(key);
    const target = keyToLocalPath(key);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, data);
  },

  async delete(key) {
    assertValidKey(key);
    await fs.remove(keyToLocalPath(key));
  },

  async exists(key) {
    assertValidKey(key);
    try {
      const st = await stat(keyToLocalPath(key));
      return st.isFile();
    } catch {
      return false;
    }
  },

  async listUnder(prefix) {
    assertValidPrefix(prefix); // 允许尾斜杠的 S3 前缀惯例
    const base = keyToLocalPath(prefix);
    const root = LOCAL_ROOT();
    const out: StorageObjectStat[] = [];

    async function walk(dir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return; // 前缀不存在：空结果
      }
      for (const name of entries) {
        const full = path.join(dir, name);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          await walk(full);
        } else {
          // key 与写入侧同构：相对 storage 根的正斜杠路径
          const rel = path.relative(root, full).split(path.sep).join('/');
          out.push({ key: rel, lastModified: st.mtime });
        }
      }
    }

    await walk(base);
    return out;
  },

  async deleteMany(keys) {
    for (const key of keys) {
      await this.delete(key);
    }
  },
};

/** 已注册的替代驱动（当前仅 s3）；key 为驱动名 */
const registry = new Map<string, StorageDriver>();
let fallbackWarned = false;

export function registerStorageDriver(name: 's3', driver: StorageDriver): void {
  registry.set(name, driver);
}

/**
 * 取当前驱动：STORAGE_DRIVER=s3 且已注册 → s3；
 * 未注册/未配置 → local（s3 未注册时告警一次并回落，fail-safe 不阻断）。
 */
export function getStorageDriver(): StorageDriver {
  const wanted = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (wanted === 's3') {
    const s3 = registry.get('s3');
    if (s3) return s3;
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn('[storage] STORAGE_DRIVER=s3 but no driver registered — falling back to local (driver-s3 not loaded?)');
    }
  }
  return localDriver;
}
