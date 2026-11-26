package fingerprint

type FingerprintChapterMeta struct {
	Path           string `json:"path"`
	Title          string `json:"title,omitempty"`
	WordCount      int    `json:"wordCount"`
	CodeBlockCount int    `json:"codeBlockCount"`
	HeadingCount   int    `json:"headingCount"`
	PageURL        string `json:"pageUrl"`
}

type FingerprintRawEvent struct {
	EventType string         `json:"eventType"`
	PageURL   string         `json:"pageUrl"`
	Duration  *float64       `json:"duration,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

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

type FingerprintScoreBreakdown struct {
	ScrollProgress float64 `json:"scrollProgress"`
	TimeProgress   float64 `json:"timeProgress"`
}

type FingerprintChapterScore struct {
	Path          string                    `json:"path"`
	Score         float64                   `json:"score"`
	Breakdown     FingerprintScoreBreakdown `json:"breakdown"`
	ContentWeight float64                   `json:"contentWeight"`
	VisitCount    int                       `json:"visitCount"`
	TotalDwellMs  float64                   `json:"totalDwellMs"`
}

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

type FingerprintComputeRequest struct {
	Chapters []FingerprintChapterMeta `json:"chapters"`
	Events   []FingerprintRawEvent    `json:"events"`
	Config   *FingerprintConfig       `json:"config,omitempty"`
}

type FingerprintComputeResponse struct {
	OK     bool                 `json:"ok"`
	Result *FingerprintProgress `json:"result,omitempty"`
	Error  string               `json:"error,omitempty"`
}

type FingerprintBatchItem struct {
	RepoID   string                   `json:"repoId"`
	Chapters []FingerprintChapterMeta `json:"chapters"`
	Events   []FingerprintRawEvent    `json:"events"`
}

type FingerprintComputeBatchRequest struct {
	Items  []FingerprintBatchItem `json:"items"`
	Config *FingerprintConfig     `json:"config,omitempty"`
}

type FingerprintComputeBatchResponse struct {
	OK      bool                           `json:"ok"`
	Results map[string]FingerprintProgress `json:"results"`
	Error   string                         `json:"error,omitempty"`
}
