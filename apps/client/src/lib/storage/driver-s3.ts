import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ENGINE_CONFIG } from '@/lib/config';
import { registerStorageDriver, assertValidKey, assertValidPrefix, type StorageDriver, type StorageObjectStat } from './driver';

/**
 * S3 兼容驱动（MinIO / R2 / AWS）。本模块只在 STORAGE_DRIVER=s3 时由
 * instrumentation / apps/worker 动态 import——加载即注册（纯副作用模块），
 * 未加载时工厂保持 local（见 driver.ts 的回落告警）。
 *
 * 容器内 ./storage 仍是 tarball 解压工作集，s3 模式不要求无盘。
 */

/**
 * 缺失类错误名归一：AWS SDK 返回 NotFound，MinIO 兼容层对 GetObject 返回
 * NoSuchKey、对 Head 返回 NoSuchBucket/NotFound——真实例集成测试抓出的差异。
 */
function isNotFoundError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotFound' || name === 'NoSuchKey' || name === 'NoSuchBucket';
}

const s3Driver: StorageDriver = {
  name: 's3',

  async get(key) {
    assertValidKey(key);
    const cfg = ENGINE_CONFIG.storage.s3;
    try {
      const res = await getClient().send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  },

  async put(key, data) {
    assertValidKey(key);
    const cfg = ENGINE_CONFIG.storage.s3;
    await ensureBucket(); // 桶自举：首写前确保桶存在（memoized，之后零开销）
    await getClient().send(
      new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: data }),
    );
  },

  async delete(key) {
    assertValidKey(key);
    const cfg = ENGINE_CONFIG.storage.s3;
    await getClient().send(
      new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
    );
  },

  async exists(key) {
    assertValidKey(key);
    const cfg = ENGINE_CONFIG.storage.s3;
    try {
      await getClient().send(
        new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  },

  async listUnder(prefix) {
    assertValidPrefix(prefix); // 允许尾斜杠的 S3 前缀惯例
    const cfg = ENGINE_CONFIG.storage.s3;
    const out: StorageObjectStat[] = [];
    let token: string | undefined;
    do {
      const res = await getClient().send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents || []) {
        if (!obj.Key || !obj.LastModified) continue;
        out.push({ key: obj.Key, lastModified: obj.LastModified });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  },

  async deleteMany(keys) {
    const cfg = ENGINE_CONFIG.storage.s3;
    const S3_DELETE_BATCH = 1000; // DeleteObjects 单请求上限
    for (let i = 0; i < keys.length; i += S3_DELETE_BATCH) {
      const slice = keys.slice(i, i + S3_DELETE_BATCH);
      await getClient().send(
        new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: { Objects: slice.map((k) => ({ Key: k })) },
        }),
      );
    }
  },
};

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const cfg = ENGINE_CONFIG.storage.s3;
  cachedClient = new S3Client({
    region: cfg.region,
    // MinIO/R2 兼容：显式 endpoint + path-style（AWS 官方域名则两者皆空走默认虚拟主机风格）
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return cachedClient;
}

/**
 * 桶自举（memoized）：首写前确保桶存在——HeadBucket 404 → CreateBucket。
 * 自建 MinIO 部署"开箱即用"，无需手动 mc mb；并发创建竞态
 * （BucketAlreadyOwnedByYou）视为成功；权限类错误不阻断（读写时给真实错误）。
 */
let bucketReady: Promise<void> | null = null;

function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const cfg = ENGINE_CONFIG.storage.s3;
      try {
        await getClient().send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (status === 404 || isNotFoundError(err)) {
          await getClient()
            .send(new CreateBucketCommand({ Bucket: cfg.bucket }))
            .catch((e: { name?: string }) => {
              if (e.name !== 'BucketAlreadyOwnedByYou') throw e;
            });
          console.log(`[storage] s3 bucket created: ${cfg.bucket}`);
        }
        // 其余错误（403 等）不阻断注册：桶可能存在只是权限口径差异，实际读写会给出真实错误
      }
    })();
    bucketReady.catch(() => undefined); // 注册期 fire-and-forget 不产生 unhandled rejection
  }
  return bucketReady;
}

// ── 注册（模块唯一副作用）──
const cfg = ENGINE_CONFIG.storage.s3;
if (!cfg.bucket) {
  // 桶未配：不注册，工厂回落 local 并告警——fail-safe 优于半配置入桶
  console.warn('[storage] STORAGE_DRIVER=s3 but S3_BUCKET is empty — driver not registered, staying on local');
} else {
  registerStorageDriver('s3', s3Driver);
  void ensureBucket(); // 注册即自举（不阻塞模块加载；put 路径会兜底 await）
}
