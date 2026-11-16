package archive

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ─────────────────────────────────────────────────────────────
// S3/MinIO 资产存取（OGIS 索引写入）。
// 与 Node 侧 driver-s3.ts 的 MinIO 兼容点逐字对齐：
//   - endpoint + path-style（minio-go 默认 path-style）
//   - 桶自举：HeadBucket 404 → CreateBucket；BucketAlreadyOwnedByYou 容忍
//   - NotFound 归一：NoSuchKey/NoSuchBucket/NotFound → miss（bool=false）而非 error
// 纯 Go 依赖（minio-go），兼容 distroless static 镜像。
// env 与 Node 共享（compose 的 worker-go 已 env_file: .env 透传 S3_*）。
// ─────────────────────────────────────────────────────────────

// AssetStore 对象存储最小面（支持索引写入与读取）。
type AssetStore interface {
	EnsureBucket(ctx context.Context) error
	Put(ctx context.Context, key string, data []byte) error
	Exists(ctx context.Context, key string) (bool, error)
	Get(ctx context.Context, key string) ([]byte, error)
}

type S3AssetStore struct {
	cli    *minio.Client
	bucket string
	region string
}


// NewS3AssetStoreFromConfig STORAGE_DRIVER=s3 且端点/桶/凭证齐备时返回客户端；
// 配置缺失返回 nil（调用方据此禁用 Go 打包，local 模式由 Node 覆盖）。
func NewS3AssetStoreFromConfig(cfg Config) *S3AssetStore {
	if cfg.StorageDriver != "s3" || cfg.S3Endpoint == "" || cfg.S3Bucket == "" {
		return nil
	}
	endpoint, err := url.Parse(cfg.S3Endpoint)
	if err != nil {
		log.Printf("[search-index] invalid S3_ENDPOINT: %v", err)
		return nil
	}
	secure := endpoint.Scheme == "https"
	region := cfg.S3Region
	if region == "" {
		region = "us-east-1"
	}
	cli, err := minio.New(endpoint.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.S3AccessKeyID, cfg.S3SecretAccessKey, ""),
		Secure: secure,
		Region: region,
	})
	if err != nil {
		log.Printf("[search-index] minio client init failed: %v", err)
		return nil
	}
	return &S3AssetStore{cli: cli, bucket: cfg.S3Bucket, region: region}
}

func newS3AssetStoreFromConfig(cfg Config) *S3AssetStore {
	return NewS3AssetStoreFromConfig(cfg)
}

func (s *S3AssetStore) EnsureBucket(ctx context.Context) error {
	exists, err := s.cli.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if err := s.cli.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region}); err != nil {
		// 并发自举竞态：他人已建视为成功（对齐 Node ensureBucket）
		if !isMinioBucketOwned(err) {
			return err
		}
	}
	return nil
}

func isMinioBucketOwned(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "BucketAlreadyOwnedByYou") ||
		strings.Contains(msg, "BucketAlreadyExists")
}

func (s *S3AssetStore) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.cli.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

func (s *S3AssetStore) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.cli.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		if isMinioNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

const maxS3AssetBytes = 64 << 20 // 64MB 上限，防止无界读取导致 OOM

func (s *S3AssetStore) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := s.cli.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		if isMinioNotFound(err) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, maxS3AssetBytes+1))
	if err != nil {
		if isMinioNotFound(err) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	if len(data) > maxS3AssetBytes {
		return nil, fmt.Errorf("s3 asset %q exceeds maximum limit of %d bytes", key, maxS3AssetBytes)
	}
	return data, nil
}

// IsMinioNotFound NotFound 归一：AWS=NotFound，MinIO=NoSuchKey/NoSuchBucket。
func IsMinioNotFound(err error) bool {
	if err == nil {
		return false
	}
	resp := minio.ToErrorResponse(err)
	if resp.StatusCode == http.StatusNotFound ||
		resp.Code == "NoSuchKey" ||
		resp.Code == "NoSuchBucket" ||
		resp.Code == "NotFound" {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "NoSuchKey") ||
		strings.Contains(msg, "NoSuchBucket") ||
		strings.Contains(msg, "NotFound") ||
		strings.Contains(msg, "The specified key does not exist") ||
		strings.Contains(msg, "The specified bucket does not exist")
}

func isMinioNotFound(err error) bool {
	return IsMinioNotFound(err)
}

// ─────────────────────────────────────────────────────────────
// 本地磁盘资产存取（OGIS 索引写入 local 驱动分支）。
// 对齐 Node 侧 localDriver 的文件路径规范：
//   - 写入 filepath.Join(d.baseDir, filepath.FromSlash(key))
//     （对应 ./storage/assets/{owner}/{repo}/{relPath}）
//   - 自动建父目录与 os.WriteFile
//   - Exists 判断文件存在且非目录
// ─────────────────────────────────────────────────────────────

type DiskAssetStore struct {
	baseDir string
}

type diskAssetStore = DiskAssetStore

func NewDiskAssetStore(baseDir string) *DiskAssetStore {
	if baseDir == "" {
		baseDir = "./storage"
	}
	return &DiskAssetStore{baseDir: baseDir}
}

func newDiskAssetStore(baseDir string) *DiskAssetStore {
	return NewDiskAssetStore(baseDir)
}

func (d *DiskAssetStore) EnsureBucket(ctx context.Context) error {
	return os.MkdirAll(d.baseDir, 0755)
}

func (d *DiskAssetStore) checkKey(key string) (string, error) {
	if key == "" || strings.Contains(key, "\\") || strings.HasPrefix(key, "/") || strings.Contains(key, "\x00") {
		return "", fmt.Errorf("invalid asset key: %q", key)
	}
	if len(key) >= 2 && key[1] == ':' && ((key[0] >= 'a' && key[0] <= 'z') || (key[0] >= 'A' && key[0] <= 'Z')) {
		return "", fmt.Errorf("invalid asset key: %q", key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("invalid asset key: %q", key)
		}
	}
	target := filepath.Join(d.baseDir, filepath.FromSlash(key))
	rel, err := filepath.Rel(d.baseDir, target)
	if err != nil || strings.HasPrefix(rel, "..") || rel == "." {
		return "", fmt.Errorf("invalid asset key traversal: %q", key)
	}
	return target, nil
}

func (d *DiskAssetStore) Put(ctx context.Context, key string, data []byte) error {
	target, err := d.checkKey(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".asset-put-tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, target)
}

func (d *DiskAssetStore) Exists(ctx context.Context, key string) (bool, error) {
	target, err := d.checkKey(key)
	if err != nil {
		return false, err
	}
	st, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return !st.IsDir(), nil
}

func (d *DiskAssetStore) Get(ctx context.Context, key string) ([]byte, error) {
	target, err := d.checkKey(key)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(target)
}
