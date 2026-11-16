package fingerprint

// FingerprintChapterMeta 与 TS ChapterMeta 对齐（阅读章节元数据）。
type FingerprintChapterMeta struct {
	Path           string `json:"path"`
	Title          string `json:"title,omitempty"`
	WordCount      int    `json:"wordCount"`
	CodeBlockCount int    `json:"codeBlockCount"`
	HeadingCount   int    `json:"headingCount"`
	PageURL        string `json:"pageUrl"`
}

// FingerprintRawEvent 与 TS RawTelemetryEvent 的线上投影对齐；
// createdAt/targetId 不参与打分，契约中刻意省略以压缩热路径载荷。
type FingerprintRawEvent struct {
	EventType string         `json:"eventType"`
	PageURL   string         `json:"pageUrl"`
	Duration  *float64       `json:"duration,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// FingerprintConfig 与 TS ReadingFingerprintConfig 全量对齐；
// driver 端本地 mergeConfig 后传全量配置，缺省回落 DEFAULT_CONFIG。
type FingerprintConfig struct {
	Weights struct {
		SectionCoverage float64 `json:"sectionCoverage"`
		TimeAdequacy    float64 `json:"timeAdequacy"`
		SkipPenalty     float64 `json:"skipPenalty"`
		RevisitBonus    float64 `json:"revisitBonus"`
	} `json:"weights"`
	Thresholds struct {
		SectionFocusMs       int64   `json:"sectionFocusMs"`
		ContentSkipMs        int64   `json:"contentSkipMs"`
		RevisitWindowMs      int64   `json:"revisitWindowMs"`
		ReadingSpeedWpm      float64 `json:"readingSpeedWpm"`
		MinReadTimeMs        int64   `json:"minReadTimeMs"`
		EffectivelyReadScore float64 `json:"effectivelyReadScore"`
	} `json:"thresholds"`
	ContentWeights struct {
		WordWeight      float64 `json:"wordWeight"`
		CodeBlockWeight float64 `json:"codeBlockWeight"`
		HeadingWeight   float64 `json:"headingWeight"`
	} `json:"contentWeights"`
	EventTypes struct {
		PageView     string `json:"pageView"`
		SectionFocus string `json:"sectionFocus"`
		ContentSkip  string `json:"contentSkip"`
		CodeCopy     string `json:"codeCopy"`
	} `json:"eventTypes"`
}

// FingerprintScoreBreakdown 与 TS ScoreBreakdown 对齐。
type FingerprintScoreBreakdown struct {
	ScrollProgress float64 `json:"scrollProgress"`
	TimeProgress   float64 `json:"timeProgress"`
}

// FingerprintChapterScore 与 TS ChapterScore 对齐。
type FingerprintChapterScore struct {
	Path          string                    `json:"path"`
	Score         float64                   `json:"score"`
	Breakdown     FingerprintScoreBreakdown `json:"breakdown"`
	ContentWeight float64                   `json:"contentWeight"`
	VisitCount    int                       `json:"visitCount"`
	TotalDwellMs  float64                   `json:"totalDwellMs"`
}

// FingerprintProgress 与 TS ProgressResult 对齐。
type FingerprintProgress struct {
	OverallProgress float64                   `json:"overallProgress"`
	ChapterScores   []FingerprintChapterScore `json:"chapterScores"`
	TotalChapters   int                       `json:"totalChapters"`
	EffectivelyRead int                       `json:"effectivelyRead"`
	Summary         struct {
		AvgScore float64 `json:"avgScore"`
		MaxScore float64 `json:"maxScore"`
		MinScore float64 `json:"minScore"`
	} `json:"summary"`
}

// FingerprintComputeRequest POST /v1/fingerprint/compute 请求体。
// config 为全量合并后配置（driver 端 mergeConfig 产物），缺省回落默认。
type FingerprintComputeRequest struct {
	Chapters []FingerprintChapterMeta `json:"chapters"`
	Events   []FingerprintRawEvent    `json:"events"`
	Config   *FingerprintConfig       `json:"config,omitempty"`
}

// FingerprintComputeResponse 统一响应包络。
type FingerprintComputeResponse struct {
	OK     bool                 `json:"ok"`
	Result *FingerprintProgress `json:"result,omitempty"`
	Error  string               `json:"error,omitempty"`
}

// FingerprintBatchItem 批量阅读指纹计算单项。
type FingerprintBatchItem struct {
	RepoID   string                   `json:"repoId"`
	Chapters []FingerprintChapterMeta `json:"chapters"`
	Events   []FingerprintRawEvent    `json:"events"`
}

// FingerprintComputeBatchRequest POST /v1/fingerprint/compute-batch 请求体。
type FingerprintComputeBatchRequest struct {
	Items  []FingerprintBatchItem `json:"items"`
	Config *FingerprintConfig     `json:"config,omitempty"`
}

// FingerprintComputeBatchResponse 批量响应包络。
type FingerprintComputeBatchResponse struct {
	OK      bool                           `json:"ok"`
	Results map[string]FingerprintProgress `json:"results"`
	Error   string                         `json:"error,omitempty"`
}

