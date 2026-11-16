package transcription

import (
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

// LlmCompleter LLM 完成接口（对齐 internal/pipeline.LlmCompleter）。
type LlmCompleter = pipeline.LlmCompleter

// ConceptManifest 别名对齐 internal/pipeline.ConceptManifest。
type ConceptManifest = pipeline.ConceptManifest

// MdxConvergencePipeline MDX 文本装甲收敛漏斗（统一收敛至 internal/pipeline）。
type MdxConvergencePipeline = pipeline.MdxConvergencePipeline

// MdxConvergenceResult MDX 收敛漏斗执行结果。
type MdxConvergenceResult = pipeline.MdxConvergenceResult
