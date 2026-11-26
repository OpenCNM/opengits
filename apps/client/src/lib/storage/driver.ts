import fs from 'fs-extra';
import { ignoreBestEffort } from '@/lib/best-effort';
import { stat } from 'node:fs/promises';
import path from 'path';

export interface StorageObjectStat {
  key: string;
  lastModified: Date;
}

export interface StorageDriver {
  name: 'local' | 's3';
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listUnder(prefix: string): Promise<StorageObjectStat[]>;
  deleteMany(keys: string[]): Promise<void>;
}

const LOCAL_ROOT = () => path.join(process.cwd(), 'storage');

export function assertValidKey(key: string): void {
  const invalid =
    !key ||
    key.includes('\\') ||
    key.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(key) ||
    key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (invalid) throw new Error(`invalid key: ${JSON.stringify(key)}`);
}

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
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(target);
    } catch {
      ignoreBestEffort();
      return null;
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
      ignoreBestEffort();
      return false;
    }
  },

  async listUnder(prefix) {
    assertValidPrefix(prefix);
    const base = keyToLocalPath(prefix);
    const root = LOCAL_ROOT();
    const out: StorageObjectStat[] = [];

    async function walk(dir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = path.join(dir, name);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(full);
        } catch {
          ignoreBestEffort();
          continue;
        }
        if (st.isDirectory()) {
          await walk(full);
        } else {
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

const registry = new Map<string, StorageDriver>();
let fallbackWarned = false;

export function registerStorageDriver(name: 's3', driver: StorageDriver): void {
  registry.set(name, driver);
}

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
