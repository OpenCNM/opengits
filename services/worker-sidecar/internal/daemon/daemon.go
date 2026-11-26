package daemon

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/crashguard"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/market"
	mcpsidecar "github.com/opengits/worker-sidecar/internal/mcp"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/scout"
	"github.com/opengits/worker-sidecar/internal/search"
	"github.com/opengits/worker-sidecar/internal/sse"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/transform"
	"github.com/opengits/worker-sidecar/internal/treesitter"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/valley"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

var sharedTsEngineRef *treesitter.Engine

func Run(args []string) error {
	if len(args) > 0 && args[0] == "-healthcheck" {
		workerAddr := envOr("WORKER_SIDECAR_ADDR", ":8082")
		resp, err := http.Get("http://127.0.0.1" + normalizeAddr(workerAddr) + "/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			return fmt.Errorf("worker healthcheck failed: status=%v err=%w", resp, err)
		}
		resp.Body.Close()

		mcpAddr := envOr("MCP_SIDECAR_ADDR", ":8081")
		resp2, err := http.Get("http://127.0.0.1" + normalizeAddr(mcpAddr) + "/healthz")
		if err != nil || resp2.StatusCode != http.StatusOK {
			return fmt.Errorf("mcp healthcheck failed: status=%v err=%w", resp2, err)
		}
		resp2.Body.Close()
		return nil
	}

	cfg := loadConfigFromEnv()
	if err := cfg.ValidateStartup(); err != nil {
		return fmt.Errorf("config validation failed: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	poolCfg, err := pgxpool.ParseConfig(sanitizeDatabaseURL(cfg.DatabaseURL))
	if err != nil {
		cancel()
		return fmt.Errorf("pgx pool config parse failed: %w", err)
	}
	poolCfg.MaxConns = int32(cfg.PoolMax)
	poolCfg.MinConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	cancel()
	if err != nil {
		return fmt.Errorf("pgx pool init failed: %w", err)
	}

	store := newPgxStoreWithPool(pool)
	projStore := mcpsidecar.NewProjectionStore()
	store.SetProjectionStore(projStore)

	mcpCfg := mcpsidecar.LoadConfigFromEnv()
	mcpCfg.Addr = cfg.McpAddr
	mcpCfg.DatabaseURL = cfg.DatabaseURL
	mcpCfg.InternalToken = cfg.InternalToken
	mcpServer := mcpsidecar.NewMCPServer(mcpCfg, pool, store, projStore)

	var indexBuilder *search.IndexBuilder
	if cfg.SearchIndexEnabled {
		if cfg.StorageDriver == "s3" {
			if s3 := archive.NewS3AssetStoreFromConfig(cfg.ArchiveConfig()); s3 != nil {
				indexBuilder = search.NewIndexBuilder(cfg.SearchConfig(), store, s3)
				fmt.Fprintln(os.Stderr, "[worker-sidecar] search-index builder: go (s3 assets)")
			} else {
				fmt.Fprintln(os.Stderr, "[worker-sidecar] search-index builder: disabled (STORAGE_DRIVER == s3 but S3_* unset)")
			}
		} else {
			diskStore := archive.NewDiskAssetStore(cfg.StorageRoot)
			indexBuilder = search.NewIndexBuilder(cfg.SearchConfig(), store, diskStore)
			fmt.Fprintln(os.Stderr, "[worker-sidecar] search-index builder: go (local disk assets)")
		}
	} else {
		fmt.Fprintln(os.Stderr, "[worker-sidecar] search-index builder disabled (WORKER_GO_SEARCH_INDEX == 0)")
	}

	// Bind shared tree-sitter pool to Background so per-request context cancellations do not close it.
	if sharedTsEngine, tsErr := treesitter.NewEngine(context.Background()); tsErr == nil {
		mdx.SetTsEngine(sharedTsEngine)
		concept.SetTsEngine(sharedTsEngine)
		market.SetTsEngine(sharedTsEngine)
		sharedTsEngineRef = sharedTsEngine
	} else {
		log.Printf("[worker-sidecar] warning: shared treesitter engine init failed (%v) — falling back to per-package lazy engines", tsErr)
	}

	runner := NewRunner(tasksForWorkerSidecar(cfg, store, indexBuilder), store)
	runner.Start()
	archiveEnsure := archive.NewEnsureService(cfg.ArchiveConfig())
	archiveEnsure.SetActiveKeysProvider(func(ctx context.Context) map[string]bool {
		keys, err := store.ActiveArchiveKeys(ctx)
		if err != nil {
			return nil
		}
		return keys
	})

	serverPatterns := ingest.DefaultPatterns()
	webdoc.SetContentPatternsProvider(func() webdoc.ContentPatterns {
		return webdoc.ContentPatterns{
			MainContentSelectors: serverPatterns.WebDoc.MainContentSelectors,
			NoiseSelectors:       serverPatterns.WebDoc.NoiseSelectors,
			LinkAsset:            serverPatterns.WebDoc.LinkAssetPattern,
		}
	})

	memoryGate := jobs.NewMemoryGate(cfg.MemoryGateConfig(), nil)

	sentinel := crashguard.NewCrashSentinel(cfg.StorageRoot)
	isSafeMode, backoff := sentinel.InspectAndRecord(time.Now().UTC())
	if isSafeMode {
		log.Printf("[worker-sidecar] Safe Mode ACTIVE (backoff=%v): dampening concurrency to 1 to protect against Crash Loop", backoff)
		if backoff > 0 {
			time.Sleep(backoff)
		}
	}

	llmGW := client.NewLlmGatewayClient(cfg.LlmGatewayURL, cfg.InternalToken)
	webInternal := client.NewInternalWebClient(cfg.WebInternalURL, cfg.InternalToken)

	var sharedLangs *rsg.LanguageDefinitions
	if (cfg.ImportJobsEnabled && cfg.ImportJobExecutor == "go") || (cfg.TranscriptionEnabled && cfg.TranscriptionExecutor == "go") {
		sharedLangs = rsg.DefaultLanguageDefinitions()
		if sharedTsEngineRef != nil {
			sharedLangs.SetTsEngine(sharedTsEngineRef)
		}
	}
	sharedGraphRepo := rsg.NewPgGraphStore(pool)

	var transcriptionRunner *transcription.TranscriptionRunner

	var jobRunner *jobs.Runner
	if cfg.ImportJobsEnabled {
		jobRunner = jobs.NewRunner(cfg.JobsConfig(), store)
		jobRunner.SetGate(memoryGate)
		if isSafeMode {
			jobRunner.SetSafeMode(true)
		}
		webClient := webInternal
		jobRunner.SetWebClient(webClient)
		store.SetImportReward(webClient)
		if cfg.ImportJobExecutor == "go" {
			patterns := serverPatterns
			jobRunner.SetBodyDeps(ingest.IngestBodyDeps{
				Store:       store,
				Archive:     ingest.NewLocalArchiveClient(archiveEnsure),
				Web:         webClient,
				SettleJob:   store.SettleImportJob,
				ArchiveRoot: cfg.ArchiveRoot,
				Patterns:    patterns,
				Languages:   sharedLangs,
				GraphDir:    cfg.SemanticGraphDir,
				GraphRepo:   sharedGraphRepo,
				LLM:         llmGW,
				Firecrawl:   scout.NewFirecrawlClient(cfg.FirecrawlAPIURL, ""),
				Gate:        memoryGate,
				TriggerTranscription: func() {
					if transcriptionRunner != nil {
						transcriptionRunner.TriggerPump()
					}
				},
			})
			fmt.Fprintln(os.Stderr, "[worker-sidecar] ImportJob executor: go body (mixed mode fallback to web endpoint)")
		}
		jobRunner.Start()
	} else {
		fmt.Fprintln(os.Stderr, "[worker-sidecar] ImportJob executor disabled (WORKER_GO_IMPORT_JOBS != 1)")
	}

	if cfg.TranscriptionEnabled {
		transcriptionRunner = transcription.NewTranscriptionRunner(cfg.TranscriptionConfig(), store)
		transcriptionRunner.SetMemoryGate(memoryGate)
		if isSafeMode {
			transcriptionRunner.SetSafeMode(true)
		}
		webClient := webInternal
		transcriptionRunner.SetWebClient(webClient)
		if cfg.TranscriptionExecutor == "go" {
			patterns := serverPatterns
			bodyDeps := transcription.BodyDeps{
				Web: webClient,
				PrepareFunc: func(ctx context.Context, docId, userId string, opts doc.PrepareOptions) (*doc.PrepareResult, error) {
					if opts.UserID == "" {
						opts.UserID = userId
					}
					return doc.PrepareDocumentBody(ctx, cfg.DocConfig(), patterns, store, docId, opts)
				},
				Llm:           llmGW,
				Store:         store,
				FinalizeStore: store,
				GraphRepo:     sharedGraphRepo,
				ExtractFileSymbols: func(content, filePath string) []cognitive.SymbolEntry {
					if sharedLangs == nil {
						return nil
					}
					return sharedLangs.ExtractFileAst(content, filePath).Symbols
				},
				OnIndexRefresh: func(repoId string) {
					if indexBuilder != nil {
						indexBuilder.ScheduleRefresh(repoId)
					}
					if webClient != nil && repoId != "" {
						go func() {
							rctx, rcancel := context.WithTimeout(context.Background(), 10*time.Second)
							defer rcancel()
							_ = webClient.RevalidateRepository(rctx, repoId)
						}()
					}
				},
			}
			if s3Transform := archive.NewS3AssetStoreFromConfig(cfg.ArchiveConfig()); s3Transform != nil {
				deps := bodyDeps
				deps.GoTransform = func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error) {
					return transform.RunGoTransform(ctx, transform.GoTransformDeps{
						Assets:      s3Transform,
						ArchiveRoot: cfg.ArchiveRoot,
						GitHubToken: cfg.GitHubToken,
						UserAgent:   cfg.UserAgent,
						RawBase:     cfg.RawBase,
						WebBase:     cfg.WebBase,
						Patterns:    patterns,
					}, owner, repo, branch, gitSha, path, cfg.GitHubToken)
				}
				bodyDeps = deps
			} else {
				bodyDeps.GoTransform = func(ctx context.Context, owner, repo, branch string, gitSha *string, path string) (string, error) {
					return transform.RunGoTransform(ctx, transform.GoTransformDeps{
						ArchiveRoot: cfg.ArchiveRoot,
						GitHubToken: cfg.GitHubToken,
						UserAgent:   cfg.UserAgent,
						RawBase:     cfg.RawBase,
						WebBase:     cfg.WebBase,
						Patterns:    patterns,
					}, owner, repo, branch, gitSha, path, cfg.GitHubToken)
				}
			}
			fmt.Fprintln(os.Stderr, "[worker-sidecar] transform executor: go (fetch chain: archive→raw, sanitize: in-process)")
			transcriptionRunner.SetBodyDeps(bodyDeps)
			fmt.Fprintln(os.Stderr, "[worker-sidecar] transcription executor: go body (mixed mode fallback to web endpoint)")
		}
		transcriptionRunner.Start()
	} else {
		fmt.Fprintln(os.Stderr, "[worker-sidecar] transcription executor disabled (WORKER_GO_TRANSCRIPTION != 1)")
	}

	var autoUpdateRunner *update.Runner
	var valleyAnalyzer *valley.Analyzer
	if cfg.ValleyEnabled {
		// Fail fast on invalid VALLEY_TZ because silent UTC fallback shifts the off-peak window.
		loc, err := time.LoadLocation(cfg.ValleyTZ)
		if err != nil {
			return fmt.Errorf("invalid VALLEY_TZ %q: %w", cfg.ValleyTZ, err)
		}
		valleyAnalyzer = valley.NewAnalyzer(valley.NewPgxStore(pool), loc, cfg.ValleyLookbackDays, cfg.ValleyMinHours, cfg.ValleyMaxHours)
		fmt.Fprintf(os.Stderr, "[worker-sidecar] valley scheduler enabled (tz=%s lookback=%dd window=%d-%dh)\n",
			cfg.ValleyTZ, cfg.ValleyLookbackDays, cfg.ValleyMinHours, cfg.ValleyMaxHours)
	}
	if cfg.AutoUpdateEnabled {
		autoUpdateRunner = update.NewRunner(cfg.UpdateConfig(), store)
		autoWebClient := webInternal
		autoUpdateRunner.SetWebClient(autoWebClient)
		autoUpdateRunner.OnIndexRefresh = func(repoId string) {
			if indexBuilder != nil {
				indexBuilder.ScheduleRefresh(repoId)
			}
			if autoWebClient != nil && repoId != "" {
				go func() {
					rctx, rcancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer rcancel()
					_ = autoWebClient.RevalidateRepository(rctx, repoId)
				}()
			}
		}
		if valleyAnalyzer != nil {
			va := valleyAnalyzer
			autoUpdateRunner.SetValleyGate(func() bool {
				gctx, gcancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer gcancel()
				return va.InWindow(gctx, time.Now())
			})
		}
		autoUpdateRunner.Start()
	} else {
		fmt.Fprintln(os.Stderr, "[worker-sidecar] auto-update executor disabled (WORKER_GO_AUTO_UPDATE != 1)")
	}

	sseGateway := sse.NewSSEGateway(cfg.SSEConfig(), store)
	srv := newServer(cfg, runner, sseGateway, store, archiveEnsure, indexBuilder)
	srv.SetMemoryGate(memoryGate)
	if sharedTsEngineRef != nil {
		srv.SetTsEngine(sharedTsEngineRef)
	}
	if jobRunner != nil {
		srv.SetJobsRunner(jobRunner)
	}
	srv.SetTranscriptionJitPriorityCap(cfg.TranscriptionJITPriority)
	if valleyAnalyzer != nil {
		srv.SetValleyAnalyzer(valleyAnalyzer)
	}
	srv.SetMetricsExtras(func() map[string]any {
		g := map[string]any{
			"memorygate_total_capacity": memoryGate.TotalCapacity(),
			"memorygate_used_tokens":    memoryGate.UsedTokens(),
			"memorygate_available":      memoryGate.AvailableTokens(),
			"memorygate_high_watermark": memoryGate.IsHighWatermark(),
		}
		if limit, usage, ok := memoryGate.SnapshotMemory(); ok {
			g["memory_sample_limit_bytes"] = limit
			g["memory_sample_usage_bytes"] = usage
		}
		return g
	})
	if transcriptionRunner != nil {
		srv.SetTranscriptionRunner(transcriptionRunner)
	}
	if llmGW != nil {
		edgeStore := store
		srv.SetDocLlmEdgeSync(func(ctx context.Context, repositoryId, docId, content, userId string) int {
			return transcription.SyncLlmEdgesForDocument(ctx, llmGW, edgeStore, repositoryId, docId, content, userId)
		})
		srv.SetTopologyHandler(webdoc.NewTopologyHandler(llmGW))
	}
	if llmGW != nil {
		// Load patterns and language definitions once at startup; per-request creation leaks a wazero Runtime.
		treePatterns := serverPatterns
		treeDefs := rsg.DefaultLanguageDefinitions()
		if sharedTsEngineRef != nil {
			treeDefs.SetTsEngine(sharedTsEngineRef)
		}
		treeH := pipelineb.NewHandler(
			func() cognitive.Patterns { return treePatterns },
			func() *rsg.LanguageDefinitions { return treeDefs },
			func(ctx context.Context, owner, repo, sha string) (string, error) {
				if sha == "" {
					return "", fmt.Errorf("sha required for archive ensure")
				}
				dir, _, err := archiveEnsure.Ensure(ctx, owner, repo, sha, 0, cfg.GitHubToken)
				if err != nil {
					return "", err
				}
				if dir == "" {
					return "", fmt.Errorf("archive unavailable (download timed out or repo size exceeded limit)")
				}
				return dir, nil
			},
			&pipelineb.GatewayPlanner{Client: llmGW},
			&pipelineb.GatewayModel{Client: llmGW},
			&pipelineb.GatewaySampler{Client: llmGW},
		)
		uidPtr := func(uid string) *string {
			if uid == "" {
				return nil
			}
			return &uid
		}
		treeH.WithUserFactories(
			func(uid string) pipelineb.PlannerModel {
				return &pipelineb.GatewayPlanner{Client: llmGW, UserID: uidPtr(uid)}
			},
			func(uid string) pipelineb.OutlineModel {
				return &pipelineb.GatewayModel{Client: llmGW, UserID: uidPtr(uid)}
			},
			func(uid string) pipelineb.OutlineSampler {
				return &pipelineb.GatewaySampler{Client: llmGW, UserID: uidPtr(uid)}
			},
		)
		treeH.CacheDir = cfg.TreeMapCacheDir
		treeH.SetGitHubConfig(cfg.GitHubToken, cfg.GitHubAPIBase, cfg.UserAgent)
		arcRoot := cfg.ArchiveConfig().ArchiveRoot
		if arcRoot == "" {
			arcRoot = "storage/repos"
		}
		treeH.SetArchiveStat(func(owner, repo, sha string) bool {
			st, err := os.Stat(archive.ArchiveDirFor(arcRoot, owner, repo, sha))
			return err == nil && st.IsDir()
		})
		srv.SetTreeOutlineHandler(treeH)
	}
	revalidateWebClient := webInternal
	srv.SetWebRevalidate(revalidateWebClient.RevalidateRepository)
	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 2)

	go func() {
		fmt.Fprintf(os.Stderr, "[mcp-sidecar] listening on %s (upstream: %s)\n", mcpCfg.Addr, mcpCfg.UpstreamURL)
		if err := mcpServer.HttpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("mcp server: %w", err)
		}
	}()

	go func() {
		fmt.Fprintf(os.Stderr, "[worker-sidecar] listening on %s\n", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("worker server: %w", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)

	select {
	case <-sig:
		fmt.Fprintln(os.Stderr, "[unified-sidecar] shutting down")
	case err := <-errCh:
		fmt.Fprintf(os.Stderr, "[unified-sidecar] fatal server error: %v\n", err)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if jobRunner != nil {
		jobRunner.Stop()
	}
	if transcriptionRunner != nil {
		transcriptionRunner.Stop()
	}
	if autoUpdateRunner != nil {
		autoUpdateRunner.Stop()
	}
	runner.Stop()

	_ = httpServer.Shutdown(shutdownCtx)
	_ = mcpServer.Shutdown(shutdownCtx)
	if sseGateway != nil {
		sseGateway.Close()
	}
	archiveEnsure.FlushMeta()
	pool.Close()
	fmt.Fprintln(os.Stderr, "[unified-sidecar] shutdown complete")
	return nil
}

func normalizeAddr(addr string) string {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[i:]
		}
	}
	return addr
}

func tokenEquals(provided, expected string) bool {
	if expected == "" || provided == "" {
		return false
	}
	ph := sha256.Sum256([]byte(provided))
	eh := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(ph[:], eh[:]) == 1
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
