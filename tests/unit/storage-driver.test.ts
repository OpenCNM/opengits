import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';

/**
 * StorageDriver（local）单测：key 映射与穿越防护 / 读写删存在性 /
 * 工厂选择与回落 / assets-store 领域封装。
 */

describe('storage driver (local)', () => {
  const root = path.join(process.cwd(), 'storage');

  beforeEach(() => {
    delete process.env.STORAGE_DRIVER;
    vi.resetModules();
  });
  afterEach(async () => {
    await fs.remove(path.join(root, '__driver_test__')).catch(() => undefined);
  });

  async function mod() {
    return import('@/lib/storage/driver');
  }

  it('put/get/exists/delete 往返；local 落盘路径 = storage/<key>', async () => {
    const { getStorageDriver } = await mod();
    const d = getStorageDriver();
    expect(d.name).toBe('local');

    const key = '__driver_test__/nested/img.png';
    await d.put(key, Buffer.from('hello-asset'));
    const legacyPath = path.join(root, key);
    expect(await fs.pathExists(legacyPath)).toBe(true); // 与历史目录结构同构

    expect(await d.exists(key)).toBe(true);
    const buf = await d.get(key);
    expect(buf?.toString()).toBe('hello-asset');

    await d.delete(key);
    expect(await d.exists(key)).toBe(false);
    expect(await d.get(key)).toBeNull();
  });

  it('get 对不存在/目录 key 返回 null', async () => {
    const { getStorageDriver } = await mod();
    const d = getStorageDriver();
    expect(await d.get('__driver_test__/missing.png')).toBeNull();
    await fs.ensureDir(path.join(root, '__driver_test__/dirkey'));
    expect(await d.get('__driver_test__/dirkey')).toBeNull();
  });

  it('穿越 key 抛错（.. 与绝对路径）', async () => {
    const { getStorageDriver } = await mod();
    const d = getStorageDriver();
    await expect(d.put('../evil.txt', Buffer.from('x'))).rejects.toThrow(/invalid key/);
    await expect(d.get('/etc/passwd')).rejects.toThrow(/invalid key/);
  });

  it('STORAGE_DRIVER=s3 未注册驱动时回落 local 并告警', async () => {
    process.env.STORAGE_DRIVER = 's3';
    vi.resetModules();
    const { getStorageDriver } = await import('@/lib/storage/driver');
    expect(getStorageDriver().name).toBe('local'); // T6b 注册后才会真正切换
  });
});

describe('assets-store(领域封装)', () => {
  const root = path.join(process.cwd(), 'storage');

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await fs.remove(path.join(root, 'assets', 'acme', '__store_test__')).catch(() => undefined);
  });

  it('key 布局 assets/{owner}/{repo}/{rel}，读写与旧目录结构同构', async () => {
    const store = await import('@/lib/storage/assets-store');
    expect(store.assetObjectKey('acme', '__store_test__', 'docs/a.png')).toBe(
      'assets/acme/__store_test__/docs/a.png',
    );

    await store.putAsset('acme', '__store_test__', 'docs/a.png', Buffer.from('P'));
    // local 驱动下 legacy 磁盘路径可直接读到（历史结构兼容）
    const legacy = path.join(root, 'assets', 'acme', '__store_test__', 'docs', 'a.png');
    expect((await fs.readFile(legacy)).toString()).toBe('P');

    expect(await store.assetExists('acme', '__store_test__', 'docs/a.png')).toBe(true);
    expect((await store.getAsset('acme', '__store_test__', 'docs/a.png'))?.toString()).toBe('P');
  });
});
