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

const maxS3AssetBytes = 64 << 20 // Cap S3 object reads at 64MB via io.LimitReader to prevent OOM.

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
