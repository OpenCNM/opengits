import { describe, expect, it } from 'vitest';

/**
 * S3 驱动真实例集成测试（T0.2 重建后的实机验证）。
 *
 * 仅当 S3_IT_ENDPOINT 指向真实 S3 兼容端点（MinIO/R2/AWS）时运行，
 * 否则整组 skip——无实例环境（CI/他人机器）零成本。
 *
 * 运行示例（本机 MinIO）：
 *   S3_IT_ENDPOINT=http://localhost:9000 \
 *   S3_IT_ACCESS_KEY=admin S3_IT_SECRET_KEY=password \
 *   npx vitest run tests/integration/storage-driver-s3.test.ts
 *
 * 覆盖：工厂选择 / 桶自举（首写自动建桶）/ put-get-exists-delete 往返 /
 * 不存在与目录语义 / 穿越键拒绝 / listUnder 前缀 / deleteMany 批删 / 幂等清理。
 */

const ENDPOINT = process.env.S3_IT_ENDPOINT || '';
const IT_BUCKET = process.env.S3_IT_BUCKET || 'opengits-it-test';

describe.skipIf(!ENDPOINT)('storage s3 驱动（真实例）', () => {
  it('桶自举 + 全操作往返 + 批删', async ({ }) => {
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_ENDPOINT = ENDPOINT;
    process.env.S3_BUCKET = IT_BUCKET;
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY_ID = process.env.S3_IT_ACCESS_KEY || '';
    process.env.S3_SECRET_ACCESS_KEY = process.env.S3_IT_SECRET_KEY || '';

    const { vi } = await import('vitest');
    vi.resetModules(); // env 就位后重载配置与驱动
    const { getStorageDriver } = await import('@/lib/storage/driver');
    await import('@/lib/storage/driver-s3'); // 注册副作用

    const d = getStorageDriver();
    expect(d.name).toBe('s3');

    const PREFIX = '__it_driver__';
    try {
      // put 隐含桶自举（首写前 ensureBucket 自动建桶，无需 mc mb）
      await d.put(`${PREFIX}/nested/img.png`, Buffer.from('hello-minio'));
      expect(await d.exists(`${PREFIX}/nested/img.png`)).toBe(true);
      expect((await d.get(`${PREFIX}/nested/img.png`))?.toString()).toBe('hello-minio');

      // 不存在 → null（非 reject）
      expect(await d.get(`${PREFIX}/missing.png`)).toBeNull();
      expect(await d.exists(`${PREFIX}/missing.png`)).toBe(false);

      // 穿越键拒绝（与 local 驱动同契约）
      await expect(d.put('../evil.txt', Buffer.from('x'))).rejects.toThrow(/invalid key/);
      await expect(d.get('/etc/passwd')).rejects.toThrow(/invalid key/);

      // listUnder 前缀聚合
      await d.put(`${PREFIX}/sub/2.png`, Buffer.from('2'));
      const listed = await d.listUnder(PREFIX);
      expect(listed.map((o) => o.key).sort()).toEqual(
        [`${PREFIX}/nested/img.png`, `${PREFIX}/sub/2.png`].sort(),
      );
      for (const o of listed) expect(o.lastModified).toBeInstanceOf(Date);

      // deleteMany 批删 + 单删幂等
      await d.deleteMany(listed.map((o) => o.key));
      expect(await d.listUnder(PREFIX)).toHaveLength(0);
      await d.delete(`${PREFIX}/nested/img.png`); // 已删不报错
    } finally {
      // 幂等清理：残留对象全删（桶保留，重复运行即桶已存在路径）
      const rest = await d.listUnder(PREFIX);
      if (rest.length > 0) await d.deleteMany(rest.map((o) => o.key));
      delete process.env.STORAGE_DRIVER;
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_BUCKET;
      delete process.env.S3_REGION;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
    }
  }, 60_000);
});
