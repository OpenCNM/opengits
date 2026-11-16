package daemon

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/credits"
	"github.com/opengits/worker-sidecar/internal/diff"
	"github.com/opengits/worker-sidecar/internal/dissect"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/fingerprint"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/llmstream"
	"github.com/opengits/worker-sidecar/internal/market"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/platform/authtoken"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/opengits/worker-sidecar/internal/platform/metrics"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/opengits/worker-sidecar/internal/scheduler"
	"github.com/opengits/worker-sidecar/internal/scout"
	"github.com/opengits/worker-sidecar/internal/search"
	"github.com/opengits/worker-sidecar/internal/sse"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/treesitter"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/valley"
	"github.com/opengits/worker-sidecar/internal/userinteraction"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// routes：/healthz 免鉴权（容器 healthcheck）；/v1/tasks/{name}/run 内部令牌鉴权
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	// 大纲写端点（draft/store、activate、deactivate）完工即清退 Web L1/L2：
	// 所有进程（admin 重编排/web-doc 导入/读路径自愈）的大纲变更统一经此收敛，
	// 堵「L1 失效重建从 L2 读回旧大纲」的 ~120s 幽灵窗口。
	if s.ingestH != nil {
		s.ingestH.SetOutlineChangedNotifier(s.fireWebRevalidate)
	}
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/metrics", s.internal(s.handleMetrics))
	mux.HandleFunc("POST /v1/tasks/{name}/run", s.internal(s.handleTaskRun))
	rsgH := rsg.NewHandler(s.cfg.RSGConfig(), s.getLanguageDefinitions, func() rsg.Patterns { return s.getPatterns() })
	if s.memoryGate != nil {
		rsgH.SetGate(s.memoryGate)
	}
	mux.HandleFunc("POST /v1/graph/concept-grounding", s.internal(rsgH.HandleGrounding))
	mux.HandleFunc("POST /v1/graph/symbol-lookup", s.internal(rsgH.HandleSymbolLookup))
	mux.HandleFunc("POST /v1/graph/symbol-search", s.internal(rsgH.HandleSymbolSearch))
	mux.HandleFunc("POST /v1/graph/slice-context", s.internal(rsgH.HandleTopologySlice))
	mux.HandleFunc("POST /v1/chunk/code-module", s.internal(chunker.HandleCodeModule))
	mux.HandleFunc("POST /v1/chunk/markdown", s.internal(chunker.HandleMarkdown))
	mux.HandleFunc("POST /v1/dissect/ast", s.internal(func(w http.ResponseWriter, r *http.Request) {
		dissect.HandleDissectAst(s.getTsEngine())(w, r)
	}))
	searchH := search.NewHandler(s.searchStore, s.indexBuilder, s.indexCache, s.assets, s.cfg.SemanticGraphDir)
	mux.HandleFunc("POST /v1/search/chunks", s.internal(searchH.HandleChunks))
	mux.HandleFunc("POST /v1/search/unified", s.internal(searchH.HandleUnified))
	mux.HandleFunc("POST /v1/search/index/build", s.internal(searchH.HandleIndexBuild))
	mux.HandleFunc("POST /v1/mdx/sanitize", s.internal(sanitize.HandleSanitize))
	mux.HandleFunc("POST /v1/mdx/heal", s.internal(mdx.HandleHeal))
	mux.HandleFunc("POST /v1/mdx/validate", s.internal(mdx.HandleValidate))
	archiveH := archive.NewHandler(s.cfg.ArchiveConfig(), s.archiveEnsure, s.assets, func() archive.RepoSniffer { return s.getPatterns() })
	mux.HandleFunc("POST /v1/archive/tree", s.internal(archiveH.HandleTree))
	mux.HandleFunc("POST /v1/archive/sniff", s.internal(archiveH.HandleSniff))
	mux.HandleFunc("POST /v1/archive/ensure", s.internal(archiveH.HandleEnsure))
	docH := doc.NewHandler(s.cfg.DocConfig(), s.docStore, func() doc.Patterns { return s.getPatterns() })
	s.docH = docH
	mux.HandleFunc("POST /v1/llms-txt/generate", s.internal(docH.HandleLlmsTxtGenerate))
	mux.HandleFunc("POST /v1/update/candidate-set", s.internal(s.handleUpdateCandidateSet))
	mux.HandleFunc("GET /v1/valley/window", s.internal(s.handleValleyWindow))
	mux.HandleFunc("POST /v1/update/apply", s.internal(s.handleUpdateApply))
	mux.HandleFunc("POST /v1/update/runs/create", s.internal(s.handleUpdateCreateRun))
	mux.HandleFunc("POST /v1/update/runs/claim", s.internal(s.handleUpdateClaimRun))
	mux.HandleFunc("POST /v1/update/runs/status", s.internal(s.handleUpdateRunStatus))
	diffH := diff.NewHandler(s.cfg.ArchiveRoot)
	mux.HandleFunc("POST /v1/archive/diff", s.internal(diffH.HandleArchiveDiff))
	mux.HandleFunc("POST /v1/symbols/extract", s.internal(rsgH.HandleSymbolsExtract))
	mux.HandleFunc("POST /v1/web-doc/diff", s.internal(webdoc.HandleDiff))
	if s.topologyH != nil {
		mux.HandleFunc("POST /v1/web-doc/topology", s.internal(s.topologyH.HandleTopology))
	}
	cogH := cognitive.NewHandler(s.cfg.ArchiveRoot, func() cognitive.Patterns {
		return s.getPatterns()
	}, func() cognitive.SymbolExtractor {
		if defs := s.getLanguageDefinitions(); defs != nil {
			return defs
		}
		return nil
	})
	// 按需补图：图谱缓存缺失时惰性建图并落盘（巨仓由 rsg 侧护栏拒绝，
	// 拒绝回落 404，客户端按既有契约走 TS 投影兜底）
	mux.HandleFunc("POST /v1/outline/candidates", s.internal(cogH.HandleCandidates))
	mux.HandleFunc("POST /v1/outline/rule-fallback", s.internal(cogH.HandleRuleFallback))
	mux.HandleFunc("POST /v1/outline/sanitize", s.internal(cogH.HandleSanitize))
	mux.HandleFunc("POST /v1/outline/prepare-signals", s.internal(cogH.HandlePrepareSignals))
	if s.treeOutline != nil {
		mux.HandleFunc("POST /v1/outline/tree", s.internal(s.treeOutline.HandleTreeOutline))
	}
	mux.HandleFunc("POST /v1/doc/store-chunks", s.internal(docH.HandleStoreChunks))
	mux.HandleFunc("POST /v1/cas/content/upsert", s.internal(docH.HandleUpsertContent))
	mux.HandleFunc("POST /v1/cas/content/orphan-gc", s.internal(docH.HandleOrphanContentGC))
	mux.HandleFunc("POST /v1/cas/chunks/attach", s.internal(docH.HandleAttachChunks))
	mux.HandleFunc("POST /v1/chunks/store", s.internal(docH.HandleStoreChunksAPI))
	mux.HandleFunc("POST /v1/documents/reset", s.internal(docH.HandleResetDoc))
	mux.HandleFunc("POST /v1/documents/mutation", s.internal(docH.HandleApplyDocMutations))
	mux.HandleFunc("POST /v1/documents/ownership/transfer", s.internal(docH.HandleTransferOwnership))
	mux.HandleFunc("POST /v1/fingerprint/compute", s.internal(fingerprint.HandleCompute))
	mux.HandleFunc("POST /v1/fingerprint/compute-batch", s.internal(fingerprint.HandleComputeBatch))
	scoutH := scout.NewHandler(s.cfg.ScoutConfig(), func() scout.Patterns { return s.getPatterns() })
	mux.HandleFunc("POST /v1/scout/inspect", s.internal(scoutH.HandleInspect))
	onIndexRefresh := func(id string) {
		if s.indexBuilder != nil {
			s.indexBuilder.ScheduleRefresh(id)
			if s.indexBuilder.Store() != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if meta, err := s.indexBuilder.Store().RepoMetaForIndex(ctx, id); err == nil && meta != nil {
					s.invalidateIndexCache(meta.Owner, meta.Repo)
				}
			}
		}
		s.fireWebRevalidate(id) // 市场换入改变读者端章节内容——L1 同步清退
	}
	marketH := market.NewHandler(s.cfg.MarketConfig(), s.marketStore, onIndexRefresh)
	mux.HandleFunc("POST /v1/market/jobs/list", s.internal(marketH.HandleJobsList))
	mux.HandleFunc("POST /v1/market/jobs/auth-info", s.internal(marketH.HandleJobAuthInfo))
	mux.HandleFunc("POST /v1/market/jobs/claim", s.internal(marketH.HandleJobClaim))
	mux.HandleFunc("POST /v1/market/jobs/extend-claim", s.internal(marketH.HandleJobExtendClaim))
	mux.HandleFunc("POST /v1/market/jobs/release", s.internal(marketH.HandleJobRelease))
	mux.HandleFunc("POST /v1/market/jobs/relay-settle", s.internal(marketH.HandleJobRelaySettle))
	mux.HandleFunc("POST /v1/market/jobs/mark-failed", s.internal(marketH.HandleJobMarkFailed))
	mux.HandleFunc("POST /v1/market/jobs/ensure-relay", s.internal(marketH.HandleJobEnsureRelay))
	mux.HandleFunc("POST /v1/market/jobs/retranslate-record", s.internal(marketH.HandleJobRetranslateRecord))
	mux.HandleFunc("POST /v1/market/jobs/create-stale", s.internal(marketH.HandleJobCreateStale))
	mux.HandleFunc("POST /v1/market/repo-audit", s.internal(marketH.HandleRepoAudit))
	mux.HandleFunc("POST /v1/sweeper/run", s.internal(s.handleSweeperRun))
	mux.HandleFunc("GET /v1/assets/serve", s.internal(archiveH.HandleAssetServe))
	if s.userInteractionH != nil {
		mux.HandleFunc("POST /v1/repos/view", s.internal(s.userInteractionH.HandleView))
		mux.HandleFunc("POST /v1/user/pin", s.internal(s.userInteractionH.HandlePin))
		mux.HandleFunc("POST /v1/notifications/read", s.internal(s.userInteractionH.HandleNotificationsRead))
		mux.HandleFunc("POST /v1/outline/active", s.internal(s.userInteractionH.HandleActiveOutline))
		mux.HandleFunc("POST /v1/repos/helpful", s.internal(s.userInteractionH.HandleHelpful))
		mux.HandleFunc("POST /v1/documents/status", s.internal(s.userInteractionH.HandleDocumentStatus))
		mux.HandleFunc("POST /v1/repos/ingest-status", s.internal(s.userInteractionH.HandleIngestStatus))
		mux.HandleFunc("POST /v1/search/featured", s.internal(s.userInteractionH.HandleFeaturedSearch))
		mux.HandleFunc("POST /v1/notifications/list", s.internal(s.userInteractionH.HandleNotificationsList))
		mux.HandleFunc("POST /v1/repos/pause", s.internal(s.userInteractionH.HandleRepoPause))
		mux.HandleFunc("POST /v1/chapter-versions/vote", s.internal(s.userInteractionH.HandleChapterVersionVote))
		mux.HandleFunc("POST /v1/reading/progress-sync", s.internal(s.userInteractionH.HandleReadingProgressSync))
		mux.HandleFunc("POST /v1/telemetry/events", s.internal(s.userInteractionH.HandleTelemetryEvents))
		mux.HandleFunc("POST /v1/monitor/events", s.internal(s.userInteractionH.HandleMonitorEvents))
		mux.HandleFunc("POST /v1/user/preferences/get", s.internal(s.userInteractionH.HandleUserPreferencesGet))
		mux.HandleFunc("POST /v1/usage/summary", s.internal(s.userInteractionH.HandleUsageSummary))
		mux.HandleFunc("POST /v1/documents/content", s.internal(s.userInteractionH.HandleDocumentContent))
		mux.HandleFunc("POST /v1/chapter-versions/list", s.internal(s.userInteractionH.HandleChapterVersionsList))
		mux.HandleFunc("POST /v1/chapter-versions/create", s.internal(s.userInteractionH.HandleChapterVersionCreate))
		mux.HandleFunc("POST /v1/chapter-versions/publish", s.internal(s.userInteractionH.HandleChapterVersionPublish))
		mux.HandleFunc("POST /v1/chapter-versions/delete", s.internal(s.userInteractionH.HandleChapterVersionDelete))
		mux.HandleFunc("POST /v1/chapter-versions/pin", s.internal(s.userInteractionH.HandleChapterVersionPin))
		mux.HandleFunc("POST /v1/chapter-versions/promote", s.internal(s.userInteractionH.HandleChapterVersionPromote))
			mux.HandleFunc("POST /v1/conversations/list", s.internal(s.userInteractionH.HandleConversationsList))
		mux.HandleFunc("POST /v1/conversations/messages", s.internal(s.userInteractionH.HandleConversationMessages))
		mux.HandleFunc("POST /v1/conversations/create", s.internal(s.userInteractionH.HandleConversationCreate))
		mux.HandleFunc("POST /v1/conversations/update", s.internal(s.userInteractionH.HandleConversationUpdate))
		mux.HandleFunc("POST /v1/conversations/delete", s.internal(s.userInteractionH.HandleConversationDelete))
		mux.HandleFunc("POST /v1/user/preferences/set", s.internal(s.userInteractionH.HandleUserPreferencesSet))
		mux.HandleFunc("POST /v1/mcp/tokens/list", s.internal(s.userInteractionH.HandleMcpTokensList))
		mux.HandleFunc("POST /v1/mcp/tokens/create", s.internal(s.userInteractionH.HandleMcpTokenCreate))
		mux.HandleFunc("POST /v1/mcp/tokens/revoke", s.internal(s.userInteractionH.HandleMcpTokenRevoke))
		mux.HandleFunc("POST /v1/mcp/tokens/touch", s.internal(s.userInteractionH.HandleMcpTokenTouch))
		mux.HandleFunc("POST /v1/notifications/create", s.internal(s.userInteractionH.HandleNotificationsCreate))
		mux.HandleFunc("POST /v1/notifications/clear", s.internal(s.userInteractionH.HandleNotificationsClear))
		mux.HandleFunc("POST /v1/repos/unsave", s.internal(s.userInteractionH.HandleRepoUnsave))
		mux.HandleFunc("POST /v1/repos/follow", s.internal(s.userInteractionH.HandleRepoFollow))
		mux.HandleFunc("POST /v1/user/model-providers/list", s.internal(s.userInteractionH.HandleUserModelProvidersList))
		mux.HandleFunc("POST /v1/user/model-providers/upsert", s.internal(s.userInteractionH.HandleUserModelProviderUpsert))
		mux.HandleFunc("POST /v1/user/model-providers/patch", s.internal(s.userInteractionH.HandleUserModelProviderPatch))
		mux.HandleFunc("POST /v1/user/model-providers/delete", s.internal(s.userInteractionH.HandleUserModelProviderDelete))
		mux.HandleFunc("POST /v1/user/model-providers/get-cipher", s.internal(s.userInteractionH.HandleUserModelProviderGetCipher))
		mux.HandleFunc("POST /v1/mcp/presence/touch", s.internal(s.userInteractionH.HandleMcpPresenceTouch))
		mux.HandleFunc("POST /v1/mcp/usage/increment", s.internal(s.userInteractionH.HandleMcpUsageIncrement))
		mux.HandleFunc("POST /v1/telemetry/mcp-call-log", s.internal(s.userInteractionH.HandleMcpCallLog))
		mux.HandleFunc("POST /v1/github/quota/sample", s.internal(s.userInteractionH.HandleGithubQuotaSample))
		mux.HandleFunc("POST /v1/mcp/bundles/use", s.internal(s.userInteractionH.HandleBundleUse))
		mux.HandleFunc("POST /v1/mcp/bundles/create", s.internal(s.userInteractionH.HandleBundleCreate))
		mux.HandleFunc("POST /v1/mcp/bundles/update", s.internal(s.userInteractionH.HandleBundleUpdate))
		mux.HandleFunc("POST /v1/mcp/bundles/delete", s.internal(s.userInteractionH.HandleBundleDelete))
		mux.HandleFunc("POST /v1/concepts/canonical/update", s.internal(s.userInteractionH.HandleUpdateCanonicalConcepts))
		mux.HandleFunc("POST /v1/concepts/edges/replace", s.internal(s.userInteractionH.HandleReplaceConceptEdges))
		mux.HandleFunc("POST /v1/user/auth-create", s.internal(s.userInteractionH.HandleUserAuthCreate))
		mux.HandleFunc("POST /v1/user/update", s.internal(s.userInteractionH.HandleUserUpdate))
		mux.HandleFunc("POST /v1/user/delete", s.internal(s.userInteractionH.HandleUserDelete))
			mux.HandleFunc("POST /v1/repos/patch", s.internal(s.userInteractionH.HandleRepoPatch))
		mux.HandleFunc("POST /v1/repos/batch-patch", s.internal(s.userInteractionH.HandleRepoBatchPatch))
		mux.HandleFunc("POST /v1/repos/increment", s.internal(s.userInteractionH.HandleRepoIncrement))
		mux.HandleFunc("POST /v1/repos/delete", s.internal(s.userInteractionH.HandleRepoDelete))
		mux.HandleFunc("POST /v1/repos/unpublish", s.internal(s.userInteractionH.HandleRepoUnpublish))
		mux.HandleFunc("POST /v1/repos/promote-edition", s.internal(s.userInteractionH.HandleRepoPromoteEdition))
	}
	if s.leaseH != nil {
		mux.HandleFunc("POST /v1/scheduler/lease/acquire", s.internal(s.leaseH.HandleAcquire))
		mux.HandleFunc("POST /v1/scheduler/lease/release", s.internal(s.leaseH.HandleRelease))
	}
	if s.creditsH != nil {
		mux.HandleFunc("POST /v1/credits/ledger", s.internal(s.creditsH.HandleLedger))
		mux.HandleFunc("POST /v1/credits/shelf-fee/charge", s.internal(s.creditsH.HandleShelfFeeCharge))
		mux.HandleFunc("POST /v1/credits/import-reward/grant", s.internal(s.creditsH.HandleImportRewardGrant))
	}
	if s.llmStreamH != nil {
		mux.HandleFunc("POST /v1/llm/stream", s.internal(s.llmStreamH.HandleStream))
	}
	if s.jobsH != nil {
			mux.HandleFunc("POST /v1/jobs/create", s.internal(s.jobsH.HandleCreateJob))
							mux.HandleFunc("POST /v1/jobs/enqueue-pump", s.internal(s.jobsH.HandleEnqueuePump))
		mux.HandleFunc("POST /v1/jobs/request-publication", s.internal(s.jobsH.HandleRequestPublication))
	}
	if s.ingestH != nil {
		mux.HandleFunc("POST /v1/ingest/snapshot/register", s.internal(s.ingestH.HandleRegisterSnapshot))
		mux.HandleFunc("POST /v1/outlines/draft/store", s.internal(s.ingestH.HandleStoreOutlineDraft))
		mux.HandleFunc("POST /v1/outlines/activate", s.internal(s.ingestH.HandleActivateOutline))
		mux.HandleFunc("POST /v1/outlines/deactivate", s.internal(s.ingestH.HandleDeactivateAllOutlines))
	}
	if s.transcriptionH != nil {
		mux.HandleFunc("POST /v1/transcription/jobs/enqueue", s.internal(s.transcriptionH.HandleEnqueue))
					mux.HandleFunc("POST /v1/transcription/staged-generate", s.internal(s.transcriptionH.HandleStagedGenerate))
		mux.HandleFunc("POST /v1/transcription/staged-relay", s.internal(s.transcriptionH.HandleStagedRelayGenerate))
							mux.HandleFunc("POST /v1/transcription/jobs/prioritize", s.internal(s.transcriptionH.HandlePrioritize))
	}
	if s.sseGateway != nil {
		s.sseGateway.RegisterRoutes(mux)
	}
	return mux
}

type Server struct {
	cfg                  Config
	runner               *Runner
	sseGateway           *sse.Gateway
	searchStore          search.Store
	llmsTxtStore         doc.LlmsTxtStore
	updateStore          update.Store
	docStore             doc.Store
	marketStore          market.Store
	sweeperStore         scheduler.OrphanSweeperStore
	userInteractionStore userinteraction.Store
	userInteractionH     *userinteraction.Handler
	leaseH               *scheduler.LeaseHandler
	creditsStore         credits.Store
	creditsH             *credits.Handler
	jobStore             jobs.QueueStore
	jobsRunner           *jobs.Runner
	jobsH                *jobs.Handler
	ingestStore          ingest.Store
	ingestH              *ingest.Handler
	transcriptionStore   transcription.QueueStore
	transcriptionH       *transcription.Handler
	docH                 *doc.Handler
	llmStreamH           *llmstream.Handler
	archiveEnsure        *archive.EnsureService
	assets               archive.AssetStore
	indexBuilder         *search.IndexBuilder
	indexCache           *search.IndexCache
	webRevalidate        func(ctx context.Context, repoId string) error
	treeOutline          *pipelineb.Handler
	topologyH            *webdoc.TopologyHandler
	// metricsExtras 额外 gauge 快照供给方（daemon 装配期注入：MemoryGate/
	// EventWriter 等运行时状态；这些组件不归 Server 所有）
	metricsExtras        func() map[string]any
	patterns             *ingest.Patterns
	patternsOnce         sync.Once
	languageDefs         *rsg.LanguageDefinitions
	languageDefsOnce     sync.Once
	tsEngine             *treesitter.Engine
	tsEngineOnce         sync.Once
	valleyA              *valley.Analyzer
	memoryGate           *jobs.MemoryGate
}

func newServer(cfg Config, runner *Runner, sseGateway *sse.Gateway, store search.Store, archiveEnsure *archive.EnsureService, indexBuilder ...*search.IndexBuilder) *Server {
	if cfg.ArchiveRoot != "" {
		cluster.SetDefaultArchiveRoot(cfg.ArchiveRoot)
	}
	var lts doc.LlmsTxtStore
	var us update.Store
	var ds doc.Store
	var ms market.Store
	var ss scheduler.OrphanSweeperStore
	if ls, ok := store.(doc.LlmsTxtStore); ok {
		lts = ls
	}
	if u, ok := store.(update.Store); ok {
		us = u
	}
	if d, ok := store.(doc.Store); ok {
		ds = d
	}
	if m, ok := store.(market.Store); ok {
		ms = m
	}
	if s, ok := store.(scheduler.OrphanSweeperStore); ok {
		ss = s
	}
	var uis userinteraction.Store
	if ui, ok := store.(userinteraction.Store); ok {
		uis = ui
	}
	var cs credits.Store
	if c, ok := store.(credits.Store); ok {
		cs = c
	}
	var js jobs.QueueStore
	if j, ok := store.(jobs.QueueStore); ok {
		js = j
	}
	var is ingest.Store
	if i, ok := store.(ingest.Store); ok {
		is = i
	}
	var ts transcription.QueueStore
	if t, ok := store.(transcription.QueueStore); ok {
		ts = t
	}
	if archiveEnsure == nil {
		archiveEnsure = archive.NewEnsureService(cfg.ArchiveConfig())
	}
	var ib *search.IndexBuilder
	if len(indexBuilder) > 0 {
		ib = indexBuilder[0]
	}
	var assets archive.AssetStore
	if ib != nil && ib.Assets() != nil {
		assets = ib.Assets()
	} else if cfg.StorageDriver == "s3" {
		assets = archive.NewS3AssetStoreFromConfig(cfg.ArchiveConfig())
	} else {
		assets = archive.NewDiskAssetStore(cfg.StorageRoot)
	}
	s := &Server{
		cfg:                  cfg,
		runner:               runner,
		sseGateway:           sseGateway,
		searchStore:          store,
		llmsTxtStore:         lts,
		updateStore:          us,
		docStore:             ds,
		marketStore:          ms,
		sweeperStore:         ss,
		userInteractionStore: uis,
		creditsStore:         cs,
		archiveEnsure:        archiveEnsure,
		assets:               assets,
		indexBuilder:         ib,
		indexCache:           search.NewIndexCache(search.DefaultIndexCacheCap),
	}
	if uis != nil {
		s.userInteractionH = userinteraction.NewHandler(uis)
	}
	if cs != nil {
		s.creditsH = credits.NewHandler(cs)
	}
	if js != nil {
		s.jobStore = js
		s.jobsH = jobs.NewHandler(js)
	}
	if is != nil {
		s.ingestStore = is
		s.ingestH = ingest.NewHandler(is)
	}
	if ts != nil {
		s.transcriptionStore = ts
		s.transcriptionH = transcription.NewHandler(ts)
	}
	if tsStore, ok := store.(scheduler.TaskStore); ok && tsStore != nil {
		s.leaseH = scheduler.NewLeaseHandler(tsStore)
	}
	s.llmStreamH = llmstream.NewHandler(llmstream.NewEngine(nil))
	if ib != nil {
		ib.SetOnBuilt(s.invalidateIndexCache)
	}
	s.loadPatterns()
	s.loadLanguageDefs()
	return s
}

// SetSchedulerStore 注入调度器租约存储。
func (s *Server) SetSchedulerStore(store scheduler.TaskStore) {
	if store != nil {
		s.leaseH = scheduler.NewLeaseHandler(store)
	}
}

// SetTranscriptionRunner 注入转录执行器，用于在入队时即时唤醒流水线。
func (s *Server) SetTranscriptionRunner(r *transcription.TranscriptionRunner) {
	if s.transcriptionH != nil {
		s.transcriptionH.SetRunner(r)
	}
	if s.userInteractionH != nil && r != nil {
		s.userInteractionH.SetOnResume(r.TriggerPump)
	}
}

// SetValleyAnalyzer 注入低谷分析器（观测端点 /v1/valley/window 用）。
func (s *Server) SetValleyAnalyzer(a *valley.Analyzer) { s.valleyA = a }

// SetTranscriptionJitPriorityCap 注入 JIT 插队优先级服务端权威上限（默认 20000）。
func (s *Server) SetTranscriptionJitPriorityCap(cap int) {
	if s.transcriptionH != nil {
		s.transcriptionH.SetJitPriorityCap(cap)
	}
}

// SetDocLlmEdgeSync 注入 LLM 概念边同步钩子到 doc finalize 落库尾端
// （daemon.Run 在 LLM 网关客户端可用时接线 transcription.SyncLlmEdgesForDocument；
// 未接线时尾端静默跳过——观测路径绝不阻断终态）。
func (s *Server) SetDocLlmEdgeSync(fn func(ctx context.Context, repositoryId, docId, content, userId string) int) {
	if s.docH != nil {
		s.docH.SetLlmEdgeSync(fn)
	}
}

// SetCreditsStore 注入积分经济存储。
func (s *Server) SetCreditsStore(store credits.Store) {
	s.creditsStore = store
	if store != nil {
		s.creditsH = credits.NewHandler(store)
	}
}

// SetUserInteractionStore 注入用户高频交互存储。
func (s *Server) SetUserInteractionStore(store userinteraction.Store) {
	s.userInteractionStore = store
	if store != nil {
		s.userInteractionH = userinteraction.NewHandler(store)
	}
}

// SetJobStore 注入导入任务队列存储。
func (s *Server) SetJobStore(store jobs.QueueStore) {
	s.jobStore = store
	if store != nil {
		s.jobsH = jobs.NewHandler(store)
		s.jobsH.SetRunner(s.jobsRunner)
	}
}

// SetJobsRunner 注入导入任务调度器（enqueue-pump 入队即时唤醒）。
func (s *Server) SetJobsRunner(r *jobs.Runner) {
	s.jobsRunner = r
	if s.jobsH != nil {
		s.jobsH.SetRunner(r)
	}
}

// SetIngestStore 注入导入持久化存储。
func (s *Server) SetIngestStore(store ingest.Store) {
	s.ingestStore = store
	if store != nil {
		s.ingestH = ingest.NewHandler(store)
	}
}

// SetTranscriptionStore 注入转录任务队列存储。
func (s *Server) SetTranscriptionStore(store transcription.QueueStore) {
	s.transcriptionStore = store
	if store != nil {
		s.transcriptionH = transcription.NewHandler(store)
	}
}

// SetLlmStreamHandler 注入 LLM 流式处理器（主要用于测试注入 mock upstream）。
func (s *Server) SetLlmStreamHandler(h *llmstream.Handler) {
	s.llmStreamH = h
}

// SetTreeOutlineHandler 注入统一树大纲端点(daemon.Run 在 LLM 网关
// 客户端可用时接线;未接线时路由不注册)。
func (s *Server) SetTreeOutlineHandler(h *pipelineb.Handler) { s.treeOutline = h }

// SetTopologyHandler 注入 web-doc 拓扑探测端点(导入确认页 scout 数据源;
// daemon.Run 构造期接线,未接线时路由不注册)。
func (s *Server) SetTopologyHandler(h *webdoc.TopologyHandler) { s.topologyH = h }

// SetWebRevalidate 注入 Web L1 投影失效回调（daemon.Run 在构造后接线——
// update apply / market swap-in 完工即清退读者端内存大纲，堵 60s 幽灵窗口）。
func (s *Server) SetWebRevalidate(f func(ctx context.Context, repoId string) error) {
	s.webRevalidate = f
}

// fireWebRevalidate 异步且有界地清退 Web L1（10s 超时；失败留痕，TTL 兜底）。
func (s *Server) fireWebRevalidate(repoId string) {
	if s.webRevalidate == nil || repoId == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.webRevalidate(ctx, repoId); err != nil {
			log.Printf("[server] web l1 revalidate warning for %s: %v", repoId, err)
		}
	}()
}

func (s *Server) invalidateIndexCache(owner, repo string) {
	if s.indexCache != nil {
		s.indexCache.InvalidateRepo(owner, repo)
	}
}

func (s *Server) loadPatterns() {
	s.patterns = ingest.DefaultPatterns()
}

func (s *Server) getPatterns() *ingest.Patterns {
	if s.patterns != nil {
		return s.patterns
	}
	s.patternsOnce.Do(s.loadPatterns)
	return s.patterns
}

func (s *Server) loadLanguageDefs() {
	s.languageDefs = rsg.DefaultLanguageDefinitions()
}

func (s *Server) getLanguageDefinitions() *rsg.LanguageDefinitions {
	if s.languageDefs != nil {
		return s.languageDefs
	}
	s.languageDefsOnce.Do(s.loadLanguageDefs)
	return s.languageDefs
}

func (s *Server) getTsEngine() *treesitter.Engine {
	s.tsEngineOnce.Do(func() {
		if s.tsEngine != nil {
			return
		}
		engine, err := treesitter.NewEngine(context.Background())
		if err == nil {
			s.tsEngine = engine
		} else {
			log.Printf("[worker-sidecar] failed to init treesitter engine: %v", err)
		}
	})
	return s.tsEngine
}

// SetTsEngine 注入进程级共享 tree-sitter 引擎（daemon 装配期调用）。
// newServer 构造时 languageDefs 已加载完毕，此处同步注入其引擎引用，
// 消除 rsg 侧再建一个独立 wazero worker 池。
func (s *Server) SetTsEngine(engine *treesitter.Engine) {
	if engine == nil {
		return
	}
	s.tsEngine = engine
	if s.languageDefs != nil {
		s.languageDefs.SetTsEngine(engine)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// SetMemoryGate 注入全局内存准入闸门（供建图等昂贵端点并发限流与高水位保护）。
func (s *Server) SetMemoryGate(g *jobs.MemoryGate) {
	s.memoryGate = g
}

// SetMetricsExtras 注入额外 gauge 快照供给方（daemon 装配期调用：
// MemoryGate/EventWriter 等不归 Server 所有的运行时状态）。
func (s *Server) SetMetricsExtras(fn func() map[string]any) {
	s.metricsExtras = fn
}

// handleMetrics 结构化运行时指标：全局计数器 + 组件 gauge 快照
//（fail-soft 降级频率、缓存命中、闸门/引擎状态——效果不劣化红线的
// 度量守护面）。
func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	gauges := map[string]any{}
	if st := rsg.DefaultAstCache.Stats(); st != (rsg.AstCacheStats{}) {
		gauges["rsg_ast_cache"] = st
	}
	if e := s.getTsEngine(); e != nil {
		gauges["treesitter_pool_capacity"] = e.PoolCapacity()
		gauges["treesitter_active_workers"] = e.ActiveWorkers()
	}
	if s.metricsExtras != nil {
		for k, v := range s.metricsExtras() {
			gauges[k] = v
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"counters": metrics.Snapshot(),
		"gauges":   gauges,
	})
}

// internal x-internal-token 鉴权中间件（sha256 常量时间比对，仅接受 Header——
// 对齐 Node internal-auth：403 语义、生产环境拒绝 compose 默认令牌、无查询串通道）。
func (s *Server) internal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if authtoken.RefuseInsecureDefault(s.cfg.InternalToken, s.cfg.AppEnv) {
			log.Printf("[worker-sidecar] INTERNAL_API_TOKEN is the public compose default — refusing in production")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "internal endpoint disabled"})
			return
		}
		token := r.Header.Get("x-internal-token")
		if !tokenEquals(token, s.cfg.InternalToken) {
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Forbidden"})
			return
		}
		next(w, r)
	}
}

// taskNamePattern 任务名白名单形态（注册表内名字均为小写字母/数字/连字符）。
var taskNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

func (s *Server) handleTaskRun(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !taskNamePattern.MatchString(name) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid task name"})
		return
	}
	if !s.runner.RunTaskByName(name) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "unknown task"})
		return
	}
	log.Printf("[worker-sidecar] manual task run completed: %s", name)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"done"}`))
}

// handleSweeperRun 响应 POST /v1/sweeper/run 请求（全站孤儿任务与超时回收）。
func (s *Server) handleSweeperRun(w http.ResponseWriter, r *http.Request) {
	if s.sweeperStore == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "sweeper store not configured")
		return
	}

	var onIndexRefresh func(repoId string)
	if s.indexBuilder != nil {
		onIndexRefresh = s.indexBuilder.ScheduleRefresh
	}

	report, err := scheduler.RunOrphanSweep(r.Context(), s.sweeperStore, s.cfg.SchedulerConfig(), onIndexRefresh)
	if err != nil {
		log.Printf("[sweeper-handler] run failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"report": report,
	})
}

func (s *Server) handleUpdateCandidateSet(w http.ResponseWriter, r *http.Request) {
	h := update.NewHandler(s.cfg.UpdateConfig(), s.updateStore, s.buildUpdateIndexRefresher())
	h.HandleUpdateCandidateSet(w, r)
}

// handleValleyWindow 低谷窗口观测端点：返回当前窗口画像（过期则顺带重算）。
// ops 侧验证调度器行为用：curl -H "Authorization: Bearer $INTERNAL_API_TOKEN" :8082/v1/valley/window
func (s *Server) handleValleyWindow(w http.ResponseWriter, r *http.Request) {
	if s.valleyA == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "valley scheduler disabled"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	win, samples, thin := s.valleyA.Window(ctx, time.Now())
	snap := s.valleyA.Snapshot()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"window":       snap.WindowLabel,
		"startHour":    win.StartHour,
		"lenHours":     win.LenHours,
		"inWindowNow":  s.valleyA.InWindow(ctx, time.Now()),
		"samples":      samples,
		"thin":         thin,
		"lookbackDays": snap.LookbackDays,
		"location":     snap.Location,
	})
}

func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	h := update.NewHandler(s.cfg.UpdateConfig(), s.updateStore, s.buildUpdateIndexRefresher())
	h.HandleUpdateApply(w, r)
}

func (s *Server) handleUpdateCreateRun(w http.ResponseWriter, r *http.Request) {
	h := update.NewHandler(s.cfg.UpdateConfig(), s.updateStore, s.buildUpdateIndexRefresher())
	h.HandleCreateRun(w, r)
}

func (s *Server) handleUpdateClaimRun(w http.ResponseWriter, r *http.Request) {
	h := update.NewHandler(s.cfg.UpdateConfig(), s.updateStore, s.buildUpdateIndexRefresher())
	h.HandleClaimRun(w, r)
}

func (s *Server) handleUpdateRunStatus(w http.ResponseWriter, r *http.Request) {
	h := update.NewHandler(s.cfg.UpdateConfig(), s.updateStore, s.buildUpdateIndexRefresher())
	h.HandleUpdateRunStatus(w, r)
}

func (s *Server) buildUpdateIndexRefresher() func(string) {
	return func(repoID string) {
		if s.indexBuilder != nil {
			s.indexBuilder.ScheduleRefresh(repoID)
			if s.indexBuilder.Store() != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if meta, err := s.indexBuilder.Store().RepoMetaForIndex(ctx, repoID); err == nil && meta != nil {
					s.invalidateIndexCache(meta.Owner, meta.Repo)
				}
			}
		}
		s.fireWebRevalidate(repoID) // 增量更新改变读者端大纲/内容——L1 同步清退
	}
}

func init() {
	update.SemanticDiffEngine = func(cfg update.Config, req diff.GraphDiffRequest) (*diff.GraphDiffResponse, error) {
		return rsg.ComputeGraphSemanticDiff(rsg.Config{ArchiveRoot: cfg.ArchiveRoot}, req)
	}
}
