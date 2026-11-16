package fingerprint

import (
	"math"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 阅读指纹引擎（Unit 3.6）：与 apps/client/src/engine/reading-fingerprint
// 的 TS 实现逐字段对齐的双实现。TS 为契约事实源（golden 夹具生成方），
// 本文件禁止任何"优化性"重排浮点运算次序——加法/乘法顺序、舍入时机
// 必须与 TS 逐行一致，否则 float64 逐位对拍必红。
// ─────────────────────────────────────────────────────────────

// DefaultFingerprintConfig 与 TS DEFAULT_CONFIG 常量逐字段一致。
func DefaultFingerprintConfig() FingerprintConfig {
	var cfg FingerprintConfig
	cfg.Weights.SectionCoverage = 0.50
	cfg.Weights.TimeAdequacy = 0.50
	cfg.Weights.SkipPenalty = 0.0
	cfg.Weights.RevisitBonus = 0.0
	cfg.Thresholds.SectionFocusMs = 10_000
	cfg.Thresholds.ContentSkipMs = 1_000
	cfg.Thresholds.RevisitWindowMs = 24 * 60 * 60 * 1000
	cfg.Thresholds.ReadingSpeedWpm = 300
	cfg.Thresholds.MinReadTimeMs = 10_000
	cfg.Thresholds.EffectivelyReadScore = 60
	cfg.ContentWeights.WordWeight = 1.0
	cfg.ContentWeights.CodeBlockWeight = 50
	cfg.ContentWeights.HeadingWeight = 20
	cfg.EventTypes.PageView = "PAGE_VIEW"
	cfg.EventTypes.SectionFocus = "SECTION_FOCUS"
	cfg.EventTypes.ContentSkip = "CONTENT_SKIP"
	cfg.EventTypes.CodeCopy = "CODE_COPY"
	return cfg
}

// jsRound 复刻 JS Math.round 的 floor(x+0.5) 语义（半值向 +∞ 取整）。
// Go math.Round 是半值远离零取整，负数输入下与 JS 分叉，禁用。
func jsRound(x float64) float64 {
	return math.Floor(x + 0.5)
}

// normalizeFingerprintURL 与 TS pageUrl.replace(/\/$/, ”).toLowerCase() 对齐：
// 仅剥一个尾部斜杠 + ASCII 大小写归一。
func normalizeFingerprintURL(url string) string {
	return strings.ToLower(strings.TrimSuffix(url, "/"))
}

// finiteScrollPercent 从 metadata.scrollPercent 提取有限数值；
// 与 TS Number.isFinite 守卫对齐，字符串/布尔/null 一律忽略。
func finiteScrollPercent(metadata map[string]any) (float64, bool) {
	if metadata == nil {
		return 0, false
	}
	raw, ok := metadata["scrollPercent"].(float64)
	if !ok || math.IsNaN(raw) || math.IsInf(raw, 0) {
		return 0, false
	}
	return raw, true
}

// fingerprintRawWeight 与 TS rawWeight 对齐：词数*词权 + 代码块*块权 + 标题*题权。
func fingerprintRawWeight(ch FingerprintChapterMeta, cfg *FingerprintConfig) float64 {
	return float64(ch.WordCount)*cfg.ContentWeights.WordWeight +
		float64(ch.CodeBlockCount)*cfg.ContentWeights.CodeBlockWeight +
		float64(ch.HeadingCount)*cfg.ContentWeights.HeadingWeight
}

// CalculateFingerprintContentWeights 与 TS calculateContentWeights 对齐：
// 全零元数据回落均匀权重 1/N。
func CalculateFingerprintContentWeights(chapters []FingerprintChapterMeta, cfg *FingerprintConfig) map[string]float64 {
	result := make(map[string]float64, len(chapters))
	if len(chapters) == 0 {
		return result
	}

	type rawWeightEntry struct {
		path   string
		weight float64
	}
	rawWeights := make([]rawWeightEntry, 0, len(chapters))
	totalWeight := 0.0
	for _, ch := range chapters {
		w := fingerprintRawWeight(ch, cfg)
		rawWeights = append(rawWeights, rawWeightEntry{path: ch.Path, weight: w})
		totalWeight += w
	}

	if totalWeight == 0 {
		equalWeight := 1 / float64(len(chapters))
		for _, rw := range rawWeights {
			result[rw.path] = equalWeight
		}
		return result
	}
	for _, rw := range rawWeights {
		result[rw.path] = rw.weight / totalWeight
	}
	return result
}

// ScoreFingerprintChapter 与 TS scoreChapter 对齐（超简逻辑：
// 短页/滚到底即 100%，其余取滚动深度与驻留时间进度的最大值）。
func ScoreFingerprintChapter(
	chapter FingerprintChapterMeta,
	events []FingerprintRawEvent,
	contentWeight float64,
	cfg *FingerprintConfig,
) FingerprintChapterScore {
	scrollPercents := make([]float64, 0, len(events))
	totalDwellMs := 0.0
	pageViewCount := 0

	for _, event := range events {
		if event.EventType == cfg.EventTypes.PageView {
			pageViewCount++
		}
		if event.Duration != nil {
			totalDwellMs += *event.Duration
		}
		if p, ok := finiteScrollPercent(event.Metadata); ok {
			scrollPercents = append(scrollPercents, p)
		}
	}

	isShortDocument := chapter.WordCount < 150 || chapter.HeadingCount <= 1
	// 与 TS 对齐：短文档（无滚动条）maxScroll 直接判满，不回退事件最大值。
	maxScroll := 0.0
	if isShortDocument {
		maxScroll = 100
	} else {
		for _, p := range scrollPercents {
			if p > maxScroll {
				maxScroll = p
			}
		}
	}

	wpm := cfg.Thresholds.ReadingSpeedWpm
	if wpm == 0 {
		wpm = 300
	}
	targetReadTimeMs := math.Max(10_000, (float64(chapter.WordCount)/wpm)*60*1000)
	timeProgress := math.Min(100, jsRound((totalDwellMs/targetReadTimeMs)*100))

	var score float64
	switch {
	case isShortDocument:
		if pageViewCount > 0 {
			score = 100
		}
	case maxScroll >= 90:
		score = 100
	default:
		score = math.Min(100, math.Max(maxScroll, timeProgress))
	}

	return FingerprintChapterScore{
		Path:  chapter.Path,
		Score: score,
		Breakdown: FingerprintScoreBreakdown{
			ScrollProgress: math.Min(100, maxScroll),
			TimeProgress:   timeProgress,
		},
		ContentWeight: contentWeight,
		VisitCount:    pageViewCount,
		TotalDwellMs:  totalDwellMs,
	}
}

// AggregateFingerprintProgress 与 TS aggregateProgress 对齐：
// 总进度 = Σ(Si×Wi)/(ΣWi×100)×100，全零权重回落简单平均。
func AggregateFingerprintProgress(chapterScores []FingerprintChapterScore, cfg *FingerprintConfig) FingerprintProgress {
	var out FingerprintProgress
	totalChapters := len(chapterScores)
	if totalChapters == 0 {
		out.ChapterScores = []FingerprintChapterScore{}
		return out
	}

	totalWeight := 0.0
	weightedScoreSum := 0.0
	simpleScoreSum := 0.0
	for _, cs := range chapterScores {
		totalWeight += cs.ContentWeight
		weightedScoreSum += cs.Score * cs.ContentWeight
		simpleScoreSum += cs.Score
	}

	var overallProgress float64
	if totalWeight > 0 {
		overallProgress = jsRound((weightedScoreSum / (totalWeight * 100)) * 100)
	} else {
		overallProgress = jsRound(simpleScoreSum / float64(totalChapters))
	}

	effectivelyRead := 0
	maxScore := chapterScores[0].Score
	minScore := chapterScores[0].Score
	for _, cs := range chapterScores {
		if cs.Score >= cfg.Thresholds.EffectivelyReadScore {
			effectivelyRead++
		}
		if cs.Score > maxScore {
			maxScore = cs.Score
		}
		if cs.Score < minScore {
			minScore = cs.Score
		}
	}

	out.OverallProgress = math.Min(100, math.Max(0, overallProgress))
	out.ChapterScores = chapterScores
	out.TotalChapters = totalChapters
	out.EffectivelyRead = effectivelyRead
	out.Summary.AvgScore = jsRound(simpleScoreSum / float64(totalChapters))
	out.Summary.MaxScore = maxScore
	out.Summary.MinScore = minScore
	return out
}

// ComputeFingerprint 与 TS computeReadingFingerprint 主入口对齐。
// cfg 为 nil 时回落 DefaultFingerprintConfig。
func ComputeFingerprint(
	chapters []FingerprintChapterMeta,
	events []FingerprintRawEvent,
	cfg *FingerprintConfig,
) FingerprintProgress {
	if cfg == nil {
		defaults := DefaultFingerprintConfig()
		cfg = &defaults
	}

	weightMap := CalculateFingerprintContentWeights(chapters, cfg)

	eventsByURL := make(map[string][]FingerprintRawEvent, len(events))
	for _, event := range events {
		key := normalizeFingerprintURL(event.PageURL)
		eventsByURL[key] = append(eventsByURL[key], event)
	}

	chapterScores := make([]FingerprintChapterScore, 0, len(chapters))
	for _, chapter := range chapters {
		chapterEvents := eventsByURL[normalizeFingerprintURL(chapter.PageURL)]
		if chapterEvents == nil {
			chapterEvents = []FingerprintRawEvent{}
		}
		weight, ok := weightMap[chapter.Path]
		if !ok {
			weight = 1 / float64(len(chapters))
		}
		chapterScores = append(chapterScores, ScoreFingerprintChapter(chapter, chapterEvents, weight, cfg))
	}

	return AggregateFingerprintProgress(chapterScores, cfg)
}
