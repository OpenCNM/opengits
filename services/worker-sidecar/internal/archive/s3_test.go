package archive

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDiskAssetStore(t *testing.T) {
	ctx := context.Background()

	t.Run("EnsureBucket creates base directory", func(t *testing.T) {
		tempDir := filepath.Join(t.TempDir(), "sub", "storage")
		store := NewDiskAssetStore(tempDir)

		err := store.EnsureBucket(ctx)
		require.NoError(t, err)

		st, err := os.Stat(tempDir)
		require.NoError(t, err)
		assert.True(t, st.IsDir())
	})

	t.Run("Put and Exists table-driven", func(t *testing.T) {
		tempDir := t.TempDir()
		store := NewDiskAssetStore(tempDir)

		tests := []struct {
			name        string
			key         string
			data        []byte
			setupDir    bool // create directory at key instead of file
			wantExists  bool
			wantContent []byte
		}{
			{
				name:        "write and read root-level key",
				key:         "manifest.json",
				data:        []byte(`{"version":1}`),
				wantExists:  true,
				wantContent: []byte(`{"version":1}`),
			},
			{
				name:        "write and read nested asset key",
				key:         "assets/owner1/repo1/search-index-sha123.bin",
				data:        []byte("binary-index-bytes"),
				wantExists:  true,
				wantContent: []byte("binary-index-bytes"),
			},
			{
				name:       "non-existent key returns false",
				key:        "assets/owner1/repo1/missing.bin",
				wantExists: false,
			},
			{
				name:       "directory key returns false from Exists",
				key:        "assets/owner1/repo1/dir-only",
				setupDir:   true,
				wantExists: false,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				if tt.setupDir {
					dirPath := filepath.Join(tempDir, filepath.FromSlash(tt.key))
					require.NoError(t, os.MkdirAll(dirPath, 0755))
				} else if tt.wantContent != nil {
					err := store.Put(ctx, tt.key, tt.data)
					require.NoError(t, err)
				}

				exists, err := store.Exists(ctx, tt.key)
				require.NoError(t, err)
				assert.Equal(t, tt.wantExists, exists)

				gotData, getErr := store.Get(ctx, tt.key)
				if tt.wantExists {
					require.NoError(t, getErr)
					assert.Equal(t, tt.wantContent, gotData)
				} else {
					assert.Error(t, getErr)
				}

				if tt.wantContent != nil {
					targetPath := filepath.Join(tempDir, filepath.FromSlash(tt.key))
					content, err := os.ReadFile(targetPath)
					require.NoError(t, err)
					assert.Equal(t, tt.wantContent, content)
				}
			})
		}
	})

	t.Run("Put, Exists and Get reject invalid keys and traversal attempts", func(t *testing.T) {
		tempDir := t.TempDir()
		store := NewDiskAssetStore(tempDir)

		badKeys := []string{
			"",
			"/absolute/path.bin",
			"../escaped.bin",
			"assets/../../escaped.bin",
			"assets/..",
			"assets/./nested.bin",
			"assets/foo//bar.bin",
			"assets\\backslash\\key.bin",
			"C:windows/win.ini",
			"assets/null\x00byte.bin",
		}

		for _, badKey := range badKeys {
			err := store.Put(ctx, badKey, []byte("data"))
			assert.Error(t, err, "Put should reject bad key: %q", badKey)

			exists, err := store.Exists(ctx, badKey)
			assert.Error(t, err, "Exists should reject bad key: %q", badKey)
			assert.False(t, exists)

			_, err = store.Get(ctx, badKey)
			assert.Error(t, err, "Get should reject bad key: %q", badKey)
		}
	})
}

func TestS3AssetStore_Config(t *testing.T) {
	tests := []struct {
		name       string
		cfg        Config
		wantNil    bool
		wantBucket string
		wantRegion string
	}{
		{
			name: "valid s3 configuration",
			cfg: Config{
				StorageDriver:     "s3",
				S3Endpoint:        "https://s3.us-west-2.amazonaws.com",
				S3Bucket:          "my-bucket",
				S3Region:          "us-west-2",
				S3AccessKeyID:     "access",
				S3SecretAccessKey: "secret",
			},
			wantNil:    false,
			wantBucket: "my-bucket",
			wantRegion: "us-west-2",
		},
		{
			name: "storage driver not s3",
			cfg: Config{
				StorageDriver: "local",
				S3Endpoint:    "http://localhost:9000",
				S3Bucket:      "my-bucket",
			},
			wantNil: true,
		},
		{
			name: "missing s3 endpoint",
			cfg: Config{
				StorageDriver: "s3",
				S3Bucket:      "my-bucket",
			},
			wantNil: true,
		},
		{
			name: "missing s3 bucket",
			cfg: Config{
				StorageDriver: "s3",
				S3Endpoint:    "http://localhost:9000",
			},
			wantNil: true,
		},
		{
			name: "default region when region is empty",
			cfg: Config{
				StorageDriver: "s3",
				S3Endpoint:    "http://localhost:9000",
				S3Bucket:      "my-bucket",
			},
			wantNil:    false,
			wantBucket: "my-bucket",
			wantRegion: "us-east-1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewS3AssetStoreFromConfig(tt.cfg)
			if tt.wantNil {
				assert.Nil(t, store)
			} else {
				require.NotNil(t, store)
				assert.Equal(t, tt.wantBucket, store.bucket)
				assert.Equal(t, tt.wantRegion, store.region)
			}
		})
	}
}

func TestS3AssetStore_MinioNotFound(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		expected bool
	}{
		{name: "nil error", err: nil, expected: false},
		{name: "NoSuchKey error", err: errors.New("The specified key does not exist. (NoSuchKey)"), expected: true},
		{name: "NoSuchBucket error", err: errors.New("The specified bucket does not exist. (NoSuchBucket)"), expected: true},
		{name: "NotFound error", err: errors.New("status code 404: NotFound"), expected: true},
		{name: "minio ErrorResponse with 404", err: minio.ErrorResponse{StatusCode: 404, Code: "NoSuchKey", Message: "The specified key does not exist."}, expected: true},
		{name: "minio ErrorResponse message only", err: errors.New("The specified key does not exist."), expected: true},
		{name: "AccessDenied error", err: errors.New("status code 403: AccessDenied"), expected: false},
		{name: "internal error", err: errors.New("connection reset by peer"), expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, IsMinioNotFound(tt.err))
			assert.Equal(t, tt.expected, isMinioNotFound(tt.err))
		})
	}
}

func TestS3AssetStore_MinioBucketOwned(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		expected bool
	}{
		{name: "nil error", err: nil, expected: false},
		{name: "BucketAlreadyOwnedByYou", err: errors.New("Your previous request to create the named bucket succeeded and you already own it. BucketAlreadyOwnedByYou"), expected: true},
		{name: "BucketAlreadyExists", err: errors.New("BucketAlreadyExists"), expected: true},
		{name: "other error", err: errors.New("AccessDenied"), expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, isMinioBucketOwned(tt.err))
		})
	}
}

func TestS3AssetStore_MockServer_CRUD(t *testing.T) {
	ctx := context.Background()
	bucketName := "test-s3-bucket"

	var mu sync.Mutex
	buckets := make(map[string]bool)
	objects := make(map[string][]byte)

	s3Server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		reqBucket := ""
		reqKey := ""
		if len(parts) > 0 {
			reqBucket = parts[0]
		}
		if len(parts) > 1 {
			reqKey = strings.Join(parts[1:], "/")
		}

		if reqKey == "" {
			switch r.Method {
			case http.MethodHead:
				if buckets[reqBucket] {
					w.WriteHeader(http.StatusOK)
				} else {
					w.WriteHeader(http.StatusNotFound)
				}
			case http.MethodPut:
				buckets[reqBucket] = true
				w.WriteHeader(http.StatusOK)
			default:
				w.WriteHeader(http.StatusMethodNotAllowed)
			}
			return
		}

		objKey := fmt.Sprintf("%s/%s", reqBucket, reqKey)
		switch r.Method {
		case http.MethodPut:
			var data []byte
			var err error
			if r.Header.Get("Content-Encoding") == "aws-chunked" {
				var out bytes.Buffer
				br := bufio.NewReader(r.Body)
				for {
					line, readErr := br.ReadString('\n')
					if readErr != nil {
						break
					}
					line = strings.TrimRight(line, "\r\n")
					parts := strings.SplitN(line, ";", 2)
					if len(parts) == 0 || parts[0] == "" {
						continue
					}
					var chunkSize int64
					if _, scanErr := fmt.Sscanf(parts[0], "%x", &chunkSize); scanErr != nil || chunkSize == 0 {
						break
					}
					chunk := make([]byte, chunkSize)
					if _, readErr := io.ReadFull(br, chunk); readErr != nil {
						break
					}
					out.Write(chunk)
					trailing := make([]byte, 2)
					_, _ = io.ReadFull(br, trailing)
				}
				data = out.Bytes()
			} else {
				data, err = io.ReadAll(r.Body)
			}
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			objects[objKey] = data
			w.Header().Set("ETag", `"etag-123"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			data, ok := objects[objKey]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
			w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"etag-123"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			data, ok := objects[objKey]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
			w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"etag-123"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer s3Server.Close()

	u, err := url.Parse(s3Server.URL)
	require.NoError(t, err)

	cli, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4("mockaccess", "mocksecret", ""),
		Secure: false,
		Region: "us-east-1",
	})
	require.NoError(t, err)

	store := &S3AssetStore{cli: cli, bucket: bucketName, region: "us-east-1"}

	// 1. EnsureBucket when bucket does not exist initially
	err = store.EnsureBucket(ctx)
	require.NoError(t, err)
	assert.True(t, buckets[bucketName])

	// 2. EnsureBucket when bucket already exists (idempotent)
	err = store.EnsureBucket(ctx)
	require.NoError(t, err)

	// 3. Exists on non-existent object
	exists, err := store.Exists(ctx, "nonexistent.png")
	require.NoError(t, err)
	assert.False(t, exists)

	// 4. Get on non-existent object returns os.ErrNotExist
	_, err = store.Get(ctx, "nonexistent.png")
	assert.ErrorIs(t, err, os.ErrNotExist)

	// 5. Put object
	testData := []byte("hello-s3-asset-content")
	err = store.Put(ctx, "images/logo.png", testData)
	require.NoError(t, err)

	// 6. Exists on existing object
	exists, err = store.Exists(ctx, "images/logo.png")
	require.NoError(t, err)
	assert.True(t, exists)

	// 7. Get existing object
	gotData, err := store.Get(ctx, "images/logo.png")
	require.NoError(t, err)
	assert.Equal(t, testData, gotData)
}
