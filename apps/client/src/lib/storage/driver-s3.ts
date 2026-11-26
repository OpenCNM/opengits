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
import { ignoreBestEffort } from '@/lib/best-effort';
import { registerStorageDriver, assertValidKey, assertValidPrefix, type StorageDriver, type StorageObjectStat } from './driver';

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
    await ensureBucket();
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
    assertValidPrefix(prefix);
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
    const S3_DELETE_BATCH = 1000;
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
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return cachedClient;
}

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
      }
    })();
    bucketReady.catch(ignoreBestEffort);
  }
  return bucketReady;
}

const cfg = ENGINE_CONFIG.storage.s3;
if (!cfg.bucket) {
  console.warn('[storage] STORAGE_DRIVER=s3 but S3_BUCKET is empty — driver not registered, staying on local');
} else {
  registerStorageDriver('s3', s3Driver);
  void ensureBucket();
}
