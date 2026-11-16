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
	"github.com/opengits/worker-sidecar/internal/treesitter"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/transform"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/valley"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// sharedTsEngineRef Run 装配期创建的进程级共享 tree-sitter 引擎（nil=
// 初始化失败，消费方回退各自包内惰性引擎）。供 runner/srv/tree-outline
// 等晚于装配点的组件注入。
var sharedTsEngineRef *treesitter.Engine

// Run 统一 sidecar 守护进程生命周期（健康检查、多端口服务、任务调度、优雅退出）。
func Run(args []string) error {
	// 容器 healthcheck 自检（distroless 无 curl/wget）：对本进程发起 GET /healthz
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
	poolCfg.MinConns = 4 // 预热防冷启动突刺（空闲成本可忽略，消除首批请求建连串行）
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

	// 进程级共享 tree-sitter 引擎：此前 mdx/concept/market/rsg（×3 实例）
	// 各自懒加载独立引擎，最坏 7+ 个 wazero worker 池、每个 worker 重编
	// ts_core.wasm。统一为一个共享池（池上限 WORKER_TS_POOL_SIZE 可覆盖）。
	// 初始化失败仅告警——各消费方均有惰性回退兜底（mdx 回退扫描、rsg 回退
	// 正则 importer、market 零分 fail-closed、concept 返回 nil）。
	// 注意必须以 context.Background() 构造：引擎生命周期=进程，绑请求级
	// ctx 会在其取消后使全部获取报 "engine is closed"。
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

	// web-doc 抓取选择器注入（单一事实源：ingest 原生模式注册表 webDoc 段）。
	// 在 job runner 与任务调度启动前完成，保证所有抓取路径都吃到注册表。
	serverPatterns := ingest.DefaultPatterns()
	webdoc.SetContentPatternsProvider(func() webdoc.ContentPatterns {
		return webdoc.ContentPatterns{
			MainContentSelectors: serverPatterns.WebDoc.MainContentSelectors,
			NoiseSelectors:       serverPatterns.WebDoc.NoiseSelectors,
			LinkAsset:            serverPatterns.WebDoc.LinkAssetPattern,
		}
	})

	// 内存两阶段加权准入控制闸门（全局共享：物理感知与总预算守恒）
	memoryGate := jobs.NewMemoryGate(cfg.MemoryGateConfig(), nil)

	// 崩溃风暴哨兵检测：识别高频连续硬崩溃并施加避震降级（Safe Mode）
	sentinel := crashguard.NewCrashSentinel(cfg.StorageRoot)
	isSafeMode, backoff := sentinel.InspectAndRecord(time.Now().UTC())
	if isSafeMode {
		log.Printf("[worker-sidecar] Safe Mode ACTIVE (backoff=%v): dampening concurrency to 1 to protect against Crash Loop", backoff)
		if backoff > 0 {
			time.Sleep(backoff)
		}
	}

	// 共享客户端：LLM 网关与内部 web 客户端全进程各一个（此前 4+4 个
	// 实例各自维护独立 keep-alive 池，对同一上游 web:3000 无法互通复用）
	llmGW := client.NewLlmGatewayClient(cfg.LlmGatewayURL, cfg.InternalToken)
	webInternal := client.NewInternalWebClient(cfg.WebInternalURL, cfg.InternalToken)

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
			langs := rsg.DefaultLanguageDefinitions()
			if sharedTsEngineRef != nil {
				langs.SetTsEngine(sharedTsEngineRef)
			}
			jobRunner.SetBodyDeps(ingest.IngestBodyDeps{
				Store:       store,
				Archive:     ingest.NewLocalArchiveClient(archiveEnsure),
				Web:         webClient,
				SettleJob:   store.SettleImportJob,
				ArchiveRoot: cfg.ArchiveRoot,
				Patterns:    patterns,
				Languages:   langs,
				GraphDir:    cfg.SemanticGraphDir,
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
	// 低谷调度器先于 auto-update 构建（门控须在 Start 前注入；观测端点共用）。
	// VALLEY_TZ 非法名 fail-fast：时区错了窗口会整体错位，静默 UTC 比拒启更危险
	var valleyAnalyzer *valley.Analyzer
	if cfg.ValleyEnabled {
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
	// /v1/metrics 的运行时 gauge 供给（MemoryGate 状态等不归 Server 所有）
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
	// LLM 概念边同步统一收敛到 doc finalize 落库尾端：Node 中继 / 浏览器直连
	// submit / Go body 三路径经 /v1/doc/finalize 或进程内 finalize 都触发同一实现，
	// 图谱密度不再随执行路径漂移（内含 MCP_LLM_EDGES 开关判定）。
	if llmGW != nil {
		edgeStore := store
		srv.SetDocLlmEdgeSync(func(ctx context.Context, repositoryId, docId, content, userId string) int {
			return transcription.SyncLlmEdgesForDocument(ctx, llmGW, edgeStore, repositoryId, docId, content, userId)
		})
		// web-doc 拓扑探测端点：导入确认页 scout 的唯一拓扑数据源
		//（构造期确定性接线，无惰性闭包伪弹性）
		srv.SetTopologyHandler(webdoc.NewTopologyHandler(llmGW))
	}
	if llmGW != nil {
		// 树大纲的 patterns/语言定义工厂改为装配期一次加载 + 闭包捕获。
		// 此前每请求重载磁盘 JSON + 每个新 LanguageDefinitions 惰性再建
		// 一个全新 wazero 引擎且从不 Close——每请求泄漏一个 wazero Runtime。
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
		// BYOK 归属:网关 keyOrigin=user 的 key 解析依赖 userId——按请求
		// 用户派生适配器(空 uid=匿名,网关侧将 MISSING_API_KEY 显式失败)
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
		// 冷启动判定接线：与 EnsureService 同根（ArchiveRoot 缺省 storage/repos），
		// 纯磁盘 stat 零下载——巨仓冷请求 202 让位，准备在后台分离 ctx 完成
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
	// Web L1 投影失效回调：update apply / market swap-in 完工即清退（带 10s 超时包装）
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
