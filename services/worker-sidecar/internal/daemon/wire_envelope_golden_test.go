package daemon

// ─────────────────────────────────────────────────────────────
// Wire Envelope Golden（/v1/* HTTP 响应信封契约冻结）
//
// 背景：纯函数奇偶校验（testdata/*.golden.json + golden_parity_test.go）
// 只锁「同输入同输出」，不锁 handler 实际返回的 JSON 信封形状。Go 侧改一个
// 响应字段名（如 chunks → data），纯函数测试照常绿，TS driver 只在线上炸。
// 本测试用反射给每个端点的响应结构体填充确定性代表值后 marshal 成
// testdata/wire-envelope.golden.json；TS 侧 tests/unit/wire-envelope-golden.test.ts
// 用 Zod 消费同一份夹具——任何一侧改信封形状，go test 与 vitest 两头红。
//
// 重新生成夹具：go test ./... -run TestWireEnvelopeGolden -update
// （或 docker run --rm -v "$PWD/services/worker-sidecar:/src" -w /src
//   golang:1.23-alpine go test -run TestWireEnvelopeGolden -update）
// ─────────────────────────────────────────────────────────────

import (
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/fingerprint"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

var wireGoldenUpdate = flag.Bool("update", false, "regenerate testdata/wire-envelope.golden.json")

// maxFillDepth 封顶递归深度：超过后保留零值——树形自引用结构（如大纲节点
// children）只展开有限层，防止无限递归；字段名在浅层已全部冻结。
const maxFillDepth = 4

// representativeFill 用确定性代表值递归填充任意结构体：
// string→"s"、数值→1、bool→true、slice→1 元素、map→1 个 "k" 键、
// 指针→分配、interface→"s"。json.Marshal 后即得稳定的非空信封形状。
func representativeFill(v reflect.Value, depth int) {
	if depth > maxFillDepth || !v.CanSet() {
		return
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		representativeFill(v.Elem(), depth+1)
	case reflect.Slice:
		// RawMessage 是 []byte 且 MarshalJSON 原样输出，必须填合法 JSON 字面量
		if v.Type().Elem().Kind() == reflect.Uint8 {
			v.SetBytes([]byte(`"s"`))
			return
		}
		v.Set(reflect.MakeSlice(v.Type(), 1, 1))
		representativeFill(v.Index(0), depth+1)
	case reflect.Map:
		v.Set(reflect.MakeMap(v.Type()))
		key := reflect.New(v.Type().Key()).Elem()
		representativeFill(key, depth+1)
		val := reflect.New(v.Type().Elem()).Elem()
		representativeFill(val, depth+1)
		v.SetMapIndex(key, val)
	case reflect.String:
		v.SetString("s")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1)
	case reflect.Struct:
		// time.Time 零值经 MarshalJSON 输出确定性的 RFC3339 字符串
		if v.Type() == reflect.TypeOf(time.Time{}) {
			return
		}
		for i := 0; i < v.NumField(); i++ {
			representativeFill(v.Field(i), depth+1)
		}
	case reflect.Interface:
		v.Set(reflect.ValueOf("s"))
	}
}

func TestWireEnvelopeGolden(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		payload  any
	}{
		{"chunk markdown", "/v1/chunk/markdown", chunker.MarkdownChunkResponse{}},
		{"chunk code-module", "/v1/chunk/code-module", chunker.CodeModuleChunkResponse{}},
		{"outline candidates", "/v1/outline/candidates", cognitive.OutlineCandidatesResponse{}},
		{"outline rule-fallback", "/v1/outline/rule-fallback", cognitive.OutlineRuleFallbackResponse{}},
		{"outline sanitize", "/v1/outline/sanitize", cognitive.OutlineSanitizeResponse{}},
		{"outline prepare-signals", "/v1/outline/prepare-signals", cognitive.OutlinePrepareSignalsResponse{}},
		{"mdx heal", "/v1/mdx/heal", mdx.HealResponse{}},
		{"mdx sanitize", "/v1/mdx/sanitize", sanitize.SanitizeResponse{}},
		{"mdx validate", "/v1/mdx/validate", mdx.ValidateResponse{}},
		{"archive tree", "/v1/archive/tree", archive.ArchiveTreeResponse{}},
		{"archive sniff", "/v1/archive/sniff", archive.ArchiveSniffResponse{}},
		{"archive ensure", "/v1/archive/ensure", archive.ArchiveEnsureResponse{}},
		{"archive diff", "/v1/archive/diff", update.UpdateArchiveDiff{}},
		{"update candidate-set", "/v1/update/candidate-set", update.UpdateCandidateResponse{}},
		{"web-doc diff", "/v1/web-doc/diff", webdoc.WebDocDiffResult{}},
		{"graph symbol-lookup", "/v1/graph/symbol-lookup", rsg.SymbolLookupResponse{}},
		{"graph concept-grounding", "/v1/graph/concept-grounding", rsg.ConceptGroundingResponse{}},
		{"symbols extract", "/v1/symbols/extract", rsg.SymbolsExtractResponse{}},
		{"fingerprint compute", "/v1/fingerprint/compute", fingerprint.FingerprintComputeResponse{}},
		{"fingerprint compute-batch", "/v1/fingerprint/compute-batch", fingerprint.FingerprintComputeBatchResponse{}},
	}

	endpoints := make(map[string]any, len(tests))
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			filled := reflect.New(reflect.TypeOf(tt.payload))
			representativeFill(filled.Elem(), 0)
			// marshal 本身即断言：结构体若含无法序列化的字段会在此暴露
			encoded, err := json.Marshal(filled.Interface())
			require.NoError(t, err, "response envelope must be JSON-marshalable")
			var decoded any
			require.NoError(t, json.Unmarshal(encoded, &decoded))
			endpoints[tt.endpoint] = decoded
		})
	}

	fixturePath := findTestData("testdata/wire-envelope.golden.json")
	doc := map[string]any{"version": 1, "endpoints": endpoints}
	out, err := json.MarshalIndent(doc, "", "  ")
	require.NoError(t, err)
	out = append(out, '\n')

	if *wireGoldenUpdate {
		require.NoError(t, os.WriteFile(fixturePath, out, 0o644))
		t.Log("fixture regenerated")
		return
	}

	raw, err := os.ReadFile(fixturePath)
	if os.IsNotExist(err) {
		t.Fatalf("%s missing (regen: go test -run TestWireEnvelopeGolden -update)", fixturePath)
	}
	require.NoError(t, err)
	assert.JSONEq(t, string(raw), string(out),
		"wire envelope 契约漂移：若为有意变更，请同步更新 TS 侧 tests/unit/wire-envelope-golden.test.ts 后重跑 -update 重新生成夹具")
}
