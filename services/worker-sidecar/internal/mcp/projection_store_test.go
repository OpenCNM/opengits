package mcp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestComputeStructuralDigest_Determinism(t *testing.T) {
	docsA := []DocMeta{
		{ID: "1", Path: "guide/getting-started.md", Title: "Getting Started"},
		{ID: "2", Path: "api/endpoints.md", Title: "API Endpoints"},
		{ID: "3", Path: "architecture.md", Title: "Architecture Overview"},
	}

	docsB := []DocMeta{
		{ID: "3", Path: "architecture.md", Title: "Architecture Overview"},
		{ID: "1", Path: "guide/getting-started.md", Title: "Getting Started"},
		{ID: "2", Path: "api/endpoints.md", Title: "API Endpoints"},
	}

	tests := []struct {
		name           string
		outlineVersion int
		docs           []DocMeta
		conceptCount   int
	}{
		{
			name:           "empty docs and zero counts",
			outlineVersion: 0,
			docs:           nil,
			conceptCount:   0,
		},
		{
			name:           "multi-document set standard order",
			outlineVersion: 2,
			docs:           docsA,
			conceptCount:   10,
		},
		{
			name:           "multi-document set shuffled order",
			outlineVersion: 2,
			docs:           docsB,
			conceptCount:   10,
		},
	}

	results := make([]string, len(tests))
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results[i] = computeStructuralDigest(tt.outlineVersion, tt.docs, tt.conceptCount)
			assert.NotEmpty(t, results[i], "digest must not be empty")
			assert.Len(t, results[i], 32, "MD5 hex string must be exactly 32 chars")
		})
	}

	assert.Equal(t, results[1], results[2], "digest must be deterministic across slice ordering")
}

func TestComputeStructuralDigest_Sensitivity(t *testing.T) {
	baseDocs := []DocMeta{
		{ID: "1", Path: "docs/intro.md", Title: "Introduction"},
		{ID: "2", Path: "docs/setup.md", Title: "Setup"},
	}
	baseOutlineVersion := 1
	baseConceptCount := 5

	baseDigest := computeStructuralDigest(baseOutlineVersion, baseDocs, baseConceptCount)

	tests := []struct {
		name           string
		outlineVersion int
		docs           []DocMeta
		conceptCount   int
	}{
		{
			name:           "add document",
			outlineVersion: baseOutlineVersion,
			docs: append(baseDocs, DocMeta{
				ID: "3", Path: "docs/advanced.md", Title: "Advanced",
			}),
			conceptCount: baseConceptCount,
		},
		{
			name:           "remove document",
			outlineVersion: baseOutlineVersion,
			docs:           baseDocs[:1],
			conceptCount:   baseConceptCount,
		},
		{
			name:           "rename document path",
			outlineVersion: baseOutlineVersion,
			docs: []DocMeta{
				{ID: "1", Path: "docs/introduction.md", Title: "Introduction"},
				{ID: "2", Path: "docs/setup.md", Title: "Setup"},
			},
			conceptCount: baseConceptCount,
		},
		{
			name:           "change document title",
			outlineVersion: baseOutlineVersion,
			docs: []DocMeta{
				{ID: "1", Path: "docs/intro.md", Title: "Introduction to System"},
				{ID: "2", Path: "docs/setup.md", Title: "Setup"},
			},
			conceptCount: baseConceptCount,
		},
		{
			name:           "change outline version",
			outlineVersion: 2,
			docs:           baseDocs,
			conceptCount:   baseConceptCount,
		},
		{
			name:           "change concept count",
			outlineVersion: baseOutlineVersion,
			docs:           baseDocs,
			conceptCount:   6,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mutatedDigest := computeStructuralDigest(tt.outlineVersion, tt.docs, tt.conceptCount)
			assert.NotEqual(t, baseDigest, mutatedDigest, "digest must jump upon structural changes")
		})
	}
}

func TestProjectionStore_FastTrackHit(t *testing.T) {
	ps := newProjectionStore()

	proj := &RepoStructuralProjection{
		RepoID:                   "repo-fast-1",
		Owner:                    "octo",
		Repo:                     "fast-repo",
		Branch:                   "main",
		Edition:                  "",
		Category:                 "Framework",
		TargetVersionLabel:       "main",
		GitSha:                   "sha-fast-001",
		IsPublic:                 true,
		McpStatus:                "ACTIVE",
		StructuralDigest:         "digest-001",
		OutlineVersion:           1,
		DocCount:                 2,
		PreRenderedListResources: "Repository: octo/fast-repo\n- Total Documents: 2\n",
		PreRenderedOutline:       "Available Documentation in octo/fast-repo:\n- Intro (docs/intro.md)\n",
		PreRenderedCourseMap:     "Course Map: octo/fast-repo\n",
		DocByPath: map[string]DocMeta{
			"docs/intro.md": {ID: "d1", Path: "docs/intro.md", Title: "Intro"},
		},
		BuiltAt:   time.Now(),
		ExpiresAt: time.Now().Add(60 * time.Second),
	}

	ps.Set(proj)

	start := time.Now()
	cached, hit := ps.Get("octo", "fast-repo", "")
	elapsed := time.Since(start)

	require.True(t, hit, "projection must hit in cache")
	require.NotNil(t, cached)
	assert.Equal(t, "repo-fast-1", cached.RepoID)
	assert.Equal(t, proj.PreRenderedOutline, cached.PreRenderedOutline)
	assert.Equal(t, proj.PreRenderedListResources, cached.PreRenderedListResources)
	assert.Equal(t, proj.PreRenderedCourseMap, cached.PreRenderedCourseMap)
	assert.Less(t, elapsed, 100*time.Microsecond, "Fast Track read must be pure in-memory < 100µs")

	cachedCase, hitCase := ps.Get("OCTO", "Fast-Repo", "")
	assert.True(t, hitCase)
	assert.Equal(t, "repo-fast-1", cachedCase.RepoID)
}

func TestProjectionStore_InvalidateAndReplace(t *testing.T) {
	ps := newProjectionStore()

	proj1 := &RepoStructuralProjection{
		RepoID:           "repo-inv-1",
		Owner:            "org",
		Repo:             "repo1",
		Edition:          "",
		StructuralDigest: "digest-1",
		ExpiresAt:        time.Now().Add(60 * time.Second),
	}
	proj2 := &RepoStructuralProjection{
		RepoID:           "repo-inv-2",
		Owner:            "org",
		Repo:             "repo2",
		Edition:          "",
		StructuralDigest: "digest-2",
		ExpiresAt:        time.Now().Add(60 * time.Second),
	}

	ps.Set(proj1)
	ps.Set(proj2)

	_, hit1 := ps.Get("org", "repo1", "")
	_, hit2 := ps.Get("org", "repo2", "")
	assert.True(t, hit1)
	assert.True(t, hit2)

	ps.Invalidate("org", "repo1")
	_, hit1After := ps.Get("org", "repo1", "")
	_, hit2After := ps.Get("org", "repo2", "")
	assert.False(t, hit1After, "repo1 must miss after Invalidate")
	assert.True(t, hit2After, "repo2 must still hit")

	ps.InvalidateByID("repo-inv-2")
	_, hit2AfterID := ps.Get("org", "repo2", "")
	assert.False(t, hit2AfterID, "repo2 must miss after InvalidateByID")

	proj1Updated := &RepoStructuralProjection{
		RepoID:           "repo-inv-1",
		Owner:            "org",
		Repo:             "repo1",
		Edition:          "",
		StructuralDigest: "digest-1-v2",
		ExpiresAt:        time.Now().Add(60 * time.Second),
	}
	ps.Set(proj1Updated)
	cachedReplaced, hitReplaced := ps.Get("org", "repo1", "")
	assert.True(t, hitReplaced)
	assert.Equal(t, "digest-1-v2", cachedReplaced.StructuralDigest)
}

func TestProjectionStore_ProseUpdateReusesProjection(t *testing.T) {
	docs := []DocMeta{
		{ID: "d1", Path: "chapter1.md", Title: "Chapter 1"},
		{ID: "d2", Path: "chapter2.md", Title: "Chapter 2"},
	}
	outlineVersion := 1
	conceptCount := 3

	sha1 := "commit-sha-00001"
	digest1 := computeStructuralDigest(outlineVersion, docs, conceptCount)

	proj := &RepoStructuralProjection{
		RepoID:                   "repo-prose",
		Owner:                    "acme",
		Repo:                     "guide",
		Branch:                   "main",
		GitSha:                   sha1,
		StructuralDigest:         digest1,
		OutlineVersion:           outlineVersion,
		DocCount:                 len(docs),
		PreRenderedOutline:       "Pre-rendered Outline for Chapter 1 and Chapter 2",
		PreRenderedListResources: "Total Documents: 2",
		ExpiresAt:                time.Now().Add(60 * time.Second),
	}

	ps := newProjectionStore()
	ps.Set(proj)

	sha2 := "commit-sha-00002"
	digest2 := computeStructuralDigest(outlineVersion, docs, conceptCount)

	assert.Equal(t, digest1, digest2, "prose update must preserve structural digest")

	cached, hit := ps.Get("acme", "guide", "")
	require.True(t, hit)
	assert.Equal(t, digest1, cached.StructuralDigest)
	assert.Equal(t, "Pre-rendered Outline for Chapter 1 and Chapter 2", cached.PreRenderedOutline)

	cached.GitSha = sha2
	ps.Set(cached)

	updated, hitUpdated := ps.Get("acme", "guide", "")
	require.True(t, hitUpdated)
	assert.Equal(t, sha2, updated.GitSha)
	assert.Equal(t, digest1, updated.StructuralDigest)
}

func TestProjectionStore_PrivateForkBypass(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	repo := makeResolvedRepo()
	store.resolved["octo/kit"] = repo
	store.repos["octo/kit"] = &repo.Repository

	privateUserID := "user_private_99"
	store.docOwners["doc-private"] = &privateUserID
	privateResolved := &ResolvedRepo{
		Repository: repo.Repository,
		Documents: append(repo.Documents, DocMeta{
			ID: "doc-private", Path: "private/draft.md", Title: "Private Draft",
		}),
	}
	store.resolved["octo/kit:"+privateUserID] = privateResolved

	var upstreamHit bool
	ts := readTestServer(t, store, &upstreamHit)

	body1 := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"outline","arguments":{}}}`
	req1, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/octo/kit", bytes.NewReader([]byte(body1)))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("Authorization", "Bearer "+goodToken)
	resp1, err := http.DefaultClient.Do(req1)
	require.NoError(t, err)
	defer resp1.Body.Close()
	assert.Equal(t, http.StatusOK, resp1.StatusCode)

	var res1 struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	require.NoError(t, json.NewDecoder(resp1.Body).Decode(&res1))
	require.NotEmpty(t, res1.Result.Content)
	assert.Contains(t, res1.Result.Content[0].Text, "Getting Started")
	assert.NotContains(t, res1.Result.Content[0].Text, "Private Draft")

	start := time.Now()
	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/octo/kit", bytes.NewReader([]byte(body1)))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+goodToken)
	resp2, err := http.DefaultClient.Do(req2)
	require.NoError(t, err)
	defer resp2.Body.Close()
	elapsed := time.Since(start)
	assert.Equal(t, http.StatusOK, resp2.StatusCode)
	assert.Less(t, elapsed, 10*time.Millisecond, "Fast Track loopback HTTP must return promptly")

	store.tokens[sha256Hex("priv-tok")] = &TokenRecord{TokenID: "t-priv", UserID: privateUserID}
	req3, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/octo/kit", bytes.NewReader([]byte(body1)))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("Authorization", "Bearer priv-tok")
	resp3, err := http.DefaultClient.Do(req3)
	require.NoError(t, err)
	defer resp3.Body.Close()
	assert.Equal(t, http.StatusOK, resp3.StatusCode)

	var res3 struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	require.NoError(t, json.NewDecoder(resp3.Body).Decode(&res3))
	require.NotEmpty(t, res3.Result.Content)
	assert.Contains(t, res3.Result.Content[0].Text, "Private Draft", "private response must contain private draft")

	req4, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/octo/kit", bytes.NewReader([]byte(body1)))
	req4.Header.Set("Content-Type", "application/json")
	req4.Header.Set("Authorization", "Bearer "+goodToken)
	resp4, err := http.DefaultClient.Do(req4)
	require.NoError(t, err)
	defer resp4.Body.Close()

	var res4 struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	require.NoError(t, json.NewDecoder(resp4.Body).Decode(&res4))
	assert.NotContains(t, res4.Result.Content[0].Text, "Private Draft", "public projection must remain clean")
}

func TestProjectionStore_InvalidateEndpoint(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	cfg := Config{
		Addr: "127.0.0.1:0", InternalToken: "secret-internal-token",
		ProxyTimeoutMs: 2000, PoolMax: 2,
	}
	srv := newServer(cfg, store)
	handler := srv.routes(http.HandlerFunc(srv.handleRoot))
	ts := httptest.NewServer(handler)
	defer ts.Close()

	proj := &RepoStructuralProjection{
		RepoID:           "repo-xyz",
		Owner:            "octo",
		Repo:             "xyz",
		StructuralDigest: "xyz-digest",
		ExpiresAt:        time.Now().Add(60 * time.Second),
	}
	srv.projectionStore.Set(proj)

	_, hit := srv.projectionStore.Get("octo", "xyz", "")
	require.True(t, hit)

	invBody := `{"repositoryId":"repo-xyz","owner":"octo","repo":"xyz"}`
	req1, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/projection/invalidate", bytes.NewReader([]byte(invBody)))
	req1.Header.Set("Content-Type", "application/json")
	resp1, err := http.DefaultClient.Do(req1)
	require.NoError(t, err)
	defer resp1.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp1.StatusCode)

	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/projection/invalidate", bytes.NewReader([]byte(invBody)))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("x-internal-token", "wrong-token")
	resp2, err := http.DefaultClient.Do(req2)
	require.NoError(t, err)
	defer resp2.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)

	req3, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/projection/invalidate", bytes.NewReader([]byte(invBody)))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("x-internal-token", "secret-internal-token")
	resp3, err := http.DefaultClient.Do(req3)
	require.NoError(t, err)
	defer resp3.Body.Close()
	assert.Equal(t, http.StatusOK, resp3.StatusCode)

	_, hitAfter := srv.projectionStore.Get("octo", "xyz", "")
	assert.False(t, hitAfter, "projection must be invalidated")
}

func BenchmarkProjectionStore_GetOutline(b *testing.B) {
	ps := newProjectionStore()
	proj := &RepoStructuralProjection{
		RepoID:                   "bench-repo-1",
		Owner:                    "octo",
		Repo:                     "bench",
		Edition:                  "",
		PreRenderedOutline:       "Pre-rendered outline for benchmarking",
		PreRenderedListResources: "Pre-rendered list resources",
		PreRenderedCourseMap:     "Pre-rendered course map",
		ExpiresAt:                time.Now().Add(60 * time.Second),
	}
	ps.Set(proj)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			p, hit := ps.Get("octo", "bench", "")
			if !hit || p == nil {
				b.Fatal("cache miss during benchmark")
			}
		}
	})
}

func TestProjectionStore_PrivateRepoStrictGate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	privRepo := &ResolvedRepo{
		Repository: RepoRow{
			ID: "repo-secret-1", Owner: "corp", Repo: "confidential", Branch: "main",
			McpStatus: "ACTIVE", Category: "Internal", IsPublic: false,
		},
		Documents: []DocMeta{
			{ID: "doc-sec-1", Path: "secret.md", Title: "Secret Specification"},
		},
	}
	store.repos["corp/confidential"] = &privRepo.Repository
	store.resolved["corp/confidential:u1"] = privRepo
	store.savedRepos["repo-secret-1|u1"] = true

	strangerToken := "token-stranger"
	store.tokens[sha256Hex(strangerToken)] = &TokenRecord{TokenID: "t-stranger", UserID: "u-stranger"}

	var upstreamHit bool
	ts := readTestServer(t, store, &upstreamHit)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"outline","arguments":{}}}`
	req1, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/corp/confidential", bytes.NewReader([]byte(body)))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("Authorization", "Bearer "+goodToken)
	resp1, err := http.DefaultClient.Do(req1)
	require.NoError(t, err)
	defer resp1.Body.Close()
	assert.Equal(t, http.StatusOK, resp1.StatusCode)

	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/corp/confidential", bytes.NewReader([]byte(body)))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+strangerToken)
	resp2, err := http.DefaultClient.Do(req2)
	require.NoError(t, err)
	defer resp2.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp2.StatusCode, "unauthorized caller must receive 403 Forbidden")
}

func TestProjectionStore_PausedRepoStrictGate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	pausedRepo := &ResolvedRepo{
		Repository: RepoRow{
			ID: "repo-paused-1", Owner: "octo", Repo: "paused-repo", Branch: "main",
			McpStatus: "PAUSED", Category: "General", IsPublic: true,
		},
		Documents: []DocMeta{
			{ID: "doc-p-1", Path: "readme.md", Title: "Readme"},
		},
	}
	store.repos["octo/paused-repo"] = &pausedRepo.Repository
	store.resolved["octo/paused-repo"] = pausedRepo

	var upstreamHit bool
	ts := readTestServer(t, store, &upstreamHit)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"outline","arguments":{}}}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/mcp/octo/paused-repo", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+goodToken)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
}

func TestProjectionStore_SecondaryIndexCleanup(t *testing.T) {
	ps := newProjectionStore()

	proj1 := &RepoStructuralProjection{
		RepoID: "repo-id-v1", Owner: "octo", Repo: "dynamic", Edition: "",
	}
	ps.Set(proj1)
	assert.Contains(t, ps.repoIDToKeys["repo-id-v1"], "octo/dynamic:")

	proj2 := &RepoStructuralProjection{
		RepoID: "repo-id-v2", Owner: "octo", Repo: "dynamic", Edition: "",
	}
	ps.Set(proj2)
	assert.NotContains(t, ps.repoIDToKeys["repo-id-v1"], "octo/dynamic:", "old repoIDToKeys must be purged on overwrite")
	assert.Contains(t, ps.repoIDToKeys["repo-id-v2"], "octo/dynamic:")
}
