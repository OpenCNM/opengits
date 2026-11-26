package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGithubGetJSONRetryAndEmptyRepo(t *testing.T) {
	tests := []struct {
		name         string
		handler      func(counter *int32, w http.ResponseWriter, _ *http.Request)
		wantCalls    int32
		wantEmpty    bool
		wantErr      bool
		checkPayload func(t *testing.T, out map[string]any)
	}{
		{
			name: "rate limited once then succeeds (Retry-After honored, no sleep)",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				if atomic.AddInt32(counter, 1) == 1 {
					w.Header().Set("Retry-After", "0")
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
				_, _ = w.Write([]byte(`{"sha":"abc"}`))
			},
			wantCalls: 2,
			checkPayload: func(t *testing.T, out map[string]any) {
				assert.Equal(t, "abc", out["sha"])
			},
		},
		{
			name: "403 with remaining=0 is treated as rate limit and retried",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				if atomic.AddInt32(counter, 1) == 1 {
					w.Header().Set("x-ratelimit-remaining", "0")
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write([]byte(`{"ok":true}`))
			},
			wantCalls: 2,
		},
		{
			name: "409 empty repo returns immediately without retry",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(counter, 1)
				w.WriteHeader(http.StatusConflict)
			},
			wantCalls: 1,
			wantEmpty: true,
			wantErr:   true,
		},
		{
			name: "404 retries once to absorb freshly-created repo eventual consistency, then terminal empty",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(counter, 1)
				w.WriteHeader(http.StatusNotFound)
			},
			wantCalls: 2,
			wantEmpty: true,
			wantErr:   true,
		},
		{
			name: "transient 404 on freshly-created repo is absorbed by single retry",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				if atomic.AddInt32(counter, 1) == 1 {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				_, _ = w.Write([]byte(`{"sha":"abc"}`))
			},
			wantCalls: 2,
			checkPayload: func(t *testing.T, out map[string]any) {
				assert.Equal(t, "abc", out["sha"])
			},
		},
		{
			name: "plain 500 fails immediately",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(counter, 1)
				w.WriteHeader(http.StatusInternalServerError)
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "mid-body truncation on large tree JSON is transient and retried to success",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				if atomic.AddInt32(counter, 1) == 1 {
					w.Header().Set("Content-Length", "1024")
					_, _ = w.Write([]byte(`{"sha":"ab`))
					panic(http.ErrAbortHandler)
				}
				_, _ = w.Write([]byte(`{"sha":"abc"}`))
			},
			wantCalls: 2,
			checkPayload: func(t *testing.T, out map[string]any) {
				assert.Equal(t, "abc", out["sha"])
			},
		},
		{
			name: "mid-body truncation on all attempts exhausts bounded retries",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(counter, 1)
				w.Header().Set("Content-Length", "1024")
				_, _ = w.Write([]byte(`{"sha":"ab`))
				panic(http.ErrAbortHandler)
			},
			wantCalls: 3,
			wantErr:   true,
		},
		{
			name: "complete body with invalid JSON is terminal without retry",
			handler: func(counter *int32, w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt32(counter, 1)
				_, _ = w.Write([]byte(`{"sha":`))
			},
			wantCalls: 1,
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var counter int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tt.handler(&counter, w, r)
			}))
			t.Cleanup(srv.Close)

			var out map[string]any
			err := GithubGetJSON(context.Background(), srv.URL+"/repos/o/r/git/trees/main?recursive=1", "tok", "", &out)
			assert.Equal(t, tt.wantCalls, atomic.LoadInt32(&counter))
			if tt.wantErr {
				require.Error(t, err)
				assert.Equal(t, tt.wantEmpty, IsGithubEmptyRepo(err))
			} else {
				require.NoError(t, err)
				if tt.checkPayload != nil {
					tt.checkPayload(t, out)
				}
			}
		})
	}
}

func TestGithubGetJSONSendsAuthAndUA(t *testing.T) {
	var gotUA, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)

	var out json.RawMessage
	require.NoError(t, GithubGetJSON(context.Background(), srv.URL+"/x", "tok-1", "UA-Test", &out))
	assert.Equal(t, "UA-Test", gotUA)
	assert.Equal(t, "Bearer tok-1", gotAuth)
}

func TestGithubGetJSONAcceptsLargeTreeBody(t *testing.T) {
	payload := append([]byte(`{"pad":"`), bytes.Repeat([]byte("a"), 16<<20)...)
	payload = append(payload, '"', '}')
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	t.Cleanup(srv.Close)

	var out json.RawMessage
	require.NoError(t, GithubGetJSON(context.Background(), srv.URL+"/x", "tok", "", &out))
	assert.Len(t, out, len(payload))
}

func TestGithubFetchTreeRecursive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/repos/test-owner/test-repo/git/trees/v1.0.0", r.URL.Path)
		assert.Equal(t, "1", r.URL.Query().Get("recursive"))
		assert.Equal(t, "Bearer tok-test", r.Header.Get("Authorization"))

		resp := GitTreeResponse{
			SHA: "v1.0.0",
			Tree: []GitTreeEntry{
				{Path: "README.md", Type: "blob", Size: 120},
				{Path: "src/main.go", Type: "blob", Size: 450},
				{Path: "src", Type: "tree"},
			},
			Truncated: true,
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	res, err := GithubFetchTreeRecursive(context.Background(), srv.URL, "test-owner", "test-repo", "v1.0.0", "tok-test", "UA-Test")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.True(t, res.Truncated)
	assert.Len(t, res.Tree, 3)
	assert.Equal(t, "README.md", res.Tree[0].Path)
}

func TestGithubBatchGetBlobsGraphQL(t *testing.T) {
	t.Run("empty paths returns empty map without calling server", func(t *testing.T) {
		res, err := GithubBatchGetBlobsGraphQL(context.Background(), "http://dummy", "o", "r", "main", nil, "token", "")
		require.NoError(t, err)
		assert.Empty(t, res)
	})

	t.Run("missing token returns error", func(t *testing.T) {
		_, err := GithubBatchGetBlobsGraphQL(context.Background(), "http://dummy", "o", "r", "main", []string{"README.md"}, "", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "token is required")
	})

	t.Run("fetches blobs and skips null entries", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/graphql", r.URL.Path)
			assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))

			var payload map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			query, _ := payload["query"].(string)
			assert.Contains(t, query, "BatchGetFiles")
			assert.Contains(t, query, "f0:")
			assert.Contains(t, query, "f1:")

			readmeText := "# Hello World"
			mockResp := map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"f0": map[string]any{
							"text":     readmeText,
							"isBinary": false,
							"byteSize": len(readmeText),
						},
						"f1": nil,
					},
				},
			}
			_ = json.NewEncoder(w).Encode(mockResp)
		}))
		t.Cleanup(srv.Close)

		paths := []string{"README.md", "non-existent.txt"}
		res, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "sha-123", paths, "test-token", "UA-Test")
		require.NoError(t, err)
		assert.Len(t, res, 1)
		assert.Equal(t, "# Hello World", res["README.md"])
		assert.NotContains(t, res, "non-existent.txt")
	})

	t.Run("graphql rate limit retry", func(t *testing.T) {
		var counter int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if atomic.AddInt32(&counter, 1) == 1 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			text := "package main"
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"f0": map[string]any{
							"text": text,
						},
					},
				},
			})
		}))
		t.Cleanup(srv.Close)

		res, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", []string{"main.go"}, "tok", "")
		require.NoError(t, err)
		assert.Equal(t, int32(2), counter)
		assert.Equal(t, "package main", res["main.go"])
	})

	t.Run("skips binary blobs", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			text := "some binary decoded junk"
			mockResp := map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"f0": map[string]any{
							"text":     text,
							"isBinary": true,
							"byteSize": len(text),
						},
						"f1": map[string]any{
							"text":     "clean text",
							"isBinary": false,
							"byteSize": 10,
						},
					},
				},
			}
			_ = json.NewEncoder(w).Encode(mockResp)
		}))
		t.Cleanup(srv.Close)

		paths := []string{"image.png", "text.txt"}
		res, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", paths, "tok", "")
		require.NoError(t, err)
		assert.NotContains(t, res, "image.png")
		assert.Equal(t, "clean text", res["text.txt"])
	})

	t.Run("null repository returns error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			mockResp := map[string]any{
				"data": map[string]any{
					"repository": nil,
				},
				"errors": []map[string]any{
					{"message": "Could not resolve to a Repository with the name 'o/r'."},
				},
			}
			_ = json.NewEncoder(w).Encode(mockResp)
		}))
		t.Cleanup(srv.Close)

		_, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", []string{"README.md"}, "tok", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Could not resolve to a Repository")
	})

	t.Run("rate limit remaining below threshold fails fast", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("x-ratelimit-remaining", "5")
			w.WriteHeader(http.StatusForbidden)
		}))
		t.Cleanup(srv.Close)

		_, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", []string{"README.md"}, "tok", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "rate limit nearly exhausted")
	})

	t.Run("supports up to 25 files batch fetch and truncates beyond 25", func(t *testing.T) {
		var receivedQuery string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Query string `json:"query"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			receivedQuery = body.Query

			repoData := make(map[string]any)
			for i := 0; i < 25; i++ {
				repoData[fmt.Sprintf("f%d", i)] = map[string]any{
					"text":     fmt.Sprintf("content of file %d", i),
					"isBinary": false,
					"byteSize": 20,
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"repository": repoData,
				},
			})
		}))
		t.Cleanup(srv.Close)

		paths := make([]string, 27)
		for i := 0; i < 27; i++ {
			paths[i] = fmt.Sprintf("src/file_%d.ts", i)
		}
		res, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", paths, "tok", "")
		require.NoError(t, err)
		assert.Len(t, res, 25, "应恰好返回 25 个文件（截断多出的 2 个）")
		assert.Contains(t, receivedQuery, "f24:")
		assert.NotContains(t, receivedQuery, "f25:")
		assert.Equal(t, "content of file 0", res["src/file_0.ts"])
		assert.Equal(t, "content of file 24", res["src/file_24.ts"])
	})

	t.Run("skips oversized blobs (>500KB)", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			mockResp := map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"f0": map[string]any{
							"text":     "huge text content",
							"isBinary": false,
							"byteSize": 501 * 1024,
						},
						"f1": map[string]any{
							"text":     "normal text",
							"isBinary": false,
							"byteSize": 100 * 1024,
						},
					},
				},
			}
			_ = json.NewEncoder(w).Encode(mockResp)
		}))
		t.Cleanup(srv.Close)

		paths := []string{"huge.txt", "normal.txt"}
		res, err := GithubBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", paths, "tok", "")
		require.NoError(t, err)
		assert.NotContains(t, res, "huge.txt", ">500KB 文件应被跳过")
		assert.Equal(t, "normal.txt", paths[1])
		assert.Equal(t, "normal text", res["normal.txt"])
	})
}

type blobMockStats struct {
	calls       atomic.Int32
	inFlight    atomic.Int32
	maxInFlight atomic.Int32
}

func (s *blobMockStats) observe() func() {
	s.calls.Add(1)
	now := s.inFlight.Add(1)
	for {
		peak := s.maxInFlight.Load()
		if now <= peak || s.maxInFlight.CompareAndSwap(peak, now) {
			break
		}
	}
	return func() { s.inFlight.Add(-1) }
}

func graphqlBatchPaths(t *testing.T, query string) []string {
	t.Helper()
	var paths []string
	const marker = ": object(expression: \""
	for _, line := range strings.Split(query, "\n") {
		idx := strings.Index(line, marker)
		if idx < 0 {
			continue
		}
		alias := strings.TrimSpace(line[:idx])
		rest := line[idx+len(marker):]
		end := strings.Index(rest, "\"")
		if end < 0 || !strings.HasPrefix(alias, "f") {
			t.Fatalf("无法解析的 GraphQL 查询行: %q", line)
		}
		expr := rest[:end]
		sep := strings.Index(expr, ":")
		if sep < 0 {
			t.Fatalf("expression 缺少 rev:path 分隔符: %q", expr)
		}
		paths = append(paths, expr[sep+1:])
	}
	return paths
}

func respondBlobText(t *testing.T, reqPaths []string, w http.ResponseWriter) {
	t.Helper()
	repoData := make(map[string]any, len(reqPaths))
	for i, p := range reqPaths {
		text := "content of " + p
		repoData[fmt.Sprintf("f%d", i)] = map[string]any{
			"text":     text,
			"isBinary": false,
			"byteSize": len(text),
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data": map[string]any{"repository": repoData},
	})
}

func newBlobGraphQLMock(t *testing.T, respond func(t *testing.T, r *http.Request, reqPaths []string, w http.ResponseWriter)) (*httptest.Server, *blobMockStats) {
	t.Helper()
	stats := &blobMockStats{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release := stats.observe()
		defer release()
		var body struct {
			Query string `json:"query"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("mock 端点解码请求失败: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		reqPaths := graphqlBatchPaths(t, body.Query)
		if respond != nil {
			respond(t, r, reqPaths, w)
			return
		}
		respondBlobText(t, reqPaths, w)
	}))
	t.Cleanup(srv.Close)
	return srv, stats
}

func seqPaths(t *testing.T, n int) []string {
	t.Helper()
	paths := make([]string, n)
	for i := range paths {
		paths[i] = fmt.Sprintf("src/file_%d.go", i)
	}
	return paths
}

func TestGithubConcurrentBatchGetBlobsGraphQL(t *testing.T) {
	tests := []struct {
		name       string
		env        map[string]string
		paths      []string
		respond    func(t *testing.T, r *http.Request, reqPaths []string, w http.ResponseWriter)
		wantErr    bool
		wantTrunc  bool
		maxElapsed time.Duration
		check      func(t *testing.T, contents map[string]string, stats *blobMockStats)
	}{
		{
			name:  "empty paths short-circuits without any request",
			paths: nil,
			respond: func(t *testing.T, _ *http.Request, _ []string, w http.ResponseWriter) {
				t.Error("空路径不应发起任何请求")
				w.WriteHeader(http.StatusInternalServerError)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.Empty(t, contents)
				assert.EqualValues(t, 0, stats.calls.Load())
			},
		},
		{
			name:  "60 paths auto-chunk into 3 batches of 25/25/10",
			paths: seqPaths(t, 60),
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.EqualValues(t, 3, stats.calls.Load(), "60 路径应恰好拆 3 批")
				assert.Len(t, contents, 60, "三批应全部聚合")
				assert.Equal(t, "content of src/file_0.go", contents["src/file_0.go"])
				assert.Equal(t, "content of src/file_24.go", contents["src/file_24.go"], "第一批末位")
				assert.Equal(t, "content of src/file_25.go", contents["src/file_25.go"], "第二批首位")
				assert.Equal(t, "content of src/file_59.go", contents["src/file_59.go"], "第三批末位")
			},
		},
		{
			name:       "bounded pool honors BLOB_FETCH_CONCURRENCY=2 without serializing",
			env:        map[string]string{"BLOB_FETCH_CONCURRENCY": "2"},
			paths:      seqPaths(t, 75),
			maxElapsed: 0,
			respond: func(t *testing.T, _ *http.Request, reqPaths []string, w http.ResponseWriter) {
				time.Sleep(100 * time.Millisecond)
				respondBlobText(t, reqPaths, w)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.EqualValues(t, 3, stats.calls.Load())
				assert.LessOrEqual(t, stats.maxInFlight.Load(), int32(2), "并发水位不得超过 2")
				assert.EqualValues(t, 2, stats.maxInFlight.Load(), "并发池应实际并行跑满 2（而非串行）")
				assert.Len(t, contents, 75)
			},
		},
		{
			name:      "single batch failure aggregates partial with truncated=true",
			paths:     seqPaths(t, 60),
			wantTrunc: true,
			respond: func(t *testing.T, _ *http.Request, reqPaths []string, w http.ResponseWriter) {
				if len(reqPaths) > 0 && reqPaths[0] == "src/file_25.go" {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				respondBlobText(t, reqPaths, w)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.Len(t, contents, 35, "失败的第二批 25 个应被剔除，仅聚合一、三批（25+10）")
				assert.Equal(t, "content of src/file_0.go", contents["src/file_0.go"])
				assert.Equal(t, "content of src/file_59.go", contents["src/file_59.go"])
				assert.NotContains(t, contents, "src/file_25.go")
				assert.NotContains(t, contents, "src/file_49.go")
			},
		},
		{
			name:       "wallclock timeout returns already-succeeded partial immediately",
			env:        map[string]string{"BLOB_FETCH_WALLCLOCK_MS": "250", "BLOB_FETCH_CONCURRENCY": "2"},
			paths:      seqPaths(t, 50),
			wantTrunc:  true,
			maxElapsed: 1500 * time.Millisecond,
			respond: func(t *testing.T, r *http.Request, reqPaths []string, w http.ResponseWriter) {
				if len(reqPaths) > 0 && reqPaths[0] == "src/file_25.go" {
					select {
					case <-time.After(5 * time.Second):
					case <-r.Context().Done():
					}
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				respondBlobText(t, reqPaths, w)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.Len(t, contents, 25, "墙钟到点只收割已成功的第一批")
				assert.Equal(t, "content of src/file_0.go", contents["src/file_0.go"])
				assert.NotContains(t, contents, "src/file_25.go")
			},
		},
		{
			name: "blacklisted packaging/binary extensions skipped before chunking",
			paths: []string{
				"dist/bundle.min.js", "src/app.js.map", "__snapshots__/ui.snap",
				"assets/logo.png", "docs/pic.jpg", "img/icon.svg", "fonts/x.woff2",
				"docs/spec.pdf", "yarn.lock", "favicon.ico", "assets/LOGO.PNG",
				"src/index.ts", "README.md", "pkg/deep/nested.go",
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.EqualValues(t, 1, stats.calls.Load(), "剔除后仅剩 3 个路径，单批即可")
				assert.Len(t, contents, 3)
				assert.Contains(t, contents, "src/index.ts")
				assert.Contains(t, contents, "pkg/deep/nested.go")
				assert.NotContains(t, contents, "dist/bundle.min.js")
				assert.NotContains(t, contents, "assets/LOGO.PNG")
			},
		},
		{
			name:  "all-blacklisted paths short-circuit without any request",
			paths: []string{"a.png", "b.map", "c.lock", "d.snap"},
			respond: func(t *testing.T, _ *http.Request, _ []string, w http.ResponseWriter) {
				t.Error("全部命中黑名单时不应发起任何请求")
				w.WriteHeader(http.StatusInternalServerError)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.Empty(t, contents)
				assert.EqualValues(t, 0, stats.calls.Load())
			},
		},
		{
			name:      "all batches failed returns aggregated error",
			paths:     seqPaths(t, 30),
			wantErr:   true,
			wantTrunc: false,
			respond: func(t *testing.T, _ *http.Request, _ []string, w http.ResponseWriter) {
				w.WriteHeader(http.StatusInternalServerError)
			},
			check: func(t *testing.T, contents map[string]string, stats *blobMockStats) {
				assert.Nil(t, contents)
				assert.EqualValues(t, 2, stats.calls.Load())
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			srv, stats := newBlobGraphQLMock(t, tt.respond)

			start := time.Now()
			contents, truncated, err := GithubConcurrentBatchGetBlobsGraphQL(context.Background(), srv.URL, "o", "r", "main", tt.paths, "tok", "UA-Test")
			elapsed := time.Since(start)

			if tt.maxElapsed > 0 {
				assert.Less(t, elapsed, tt.maxElapsed, "应在墙钟内立即返回，不等待挂死批次")
			}
			if tt.wantErr {
				require.Error(t, err)
				assert.Contains(t, err.Error(), "all 2 batches failed")
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, tt.wantTrunc, truncated)
			if tt.check != nil {
				tt.check(t, contents, stats)
			}
		})
	}
}

func TestIsSkippableBlobPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"dist/bundle.min.js", true},
		{"src/app.js.map", true},
		{"assets/logo.PNG", true},
		{"yarn.lock", true},
		{"a/b/c.snap", true},
		{"src/index.js", false},
		{"src/map.go", false},
		{"README.md", false},
		{"", false},
		{"dist/bundle.MIN.JS", true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			assert.Equal(t, tt.want, isSkippableBlobPath(tt.path))
		})
	}
}
