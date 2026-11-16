package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/diff"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/fingerprint"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/ogis"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/opengits/worker-sidecar/internal/scout"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

func findTestData(path string) string {
	if _, err := os.Stat(path); err == nil {
		return path
	}
	alt := filepath.Join("../..", path)
	if _, err := os.Stat(alt); err == nil {
		return alt
	}
	return path
}

func derefStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ─────────────────────────────────────────────────────────────
// Chunk 落库规则 / MDX 净化 golden 对拍：
// 夹具为冻结手工维护契约（原 TS 生成脚本 gen-*-golden.ts 与 TS 实现已于
// 2026-11 死代码清算退役；本测试为 Go 端自足断言，不依赖任何 TS 运行时）。
// ─────────────────────────────────────────────────────────────

func TestChunkRulesGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/chunk-rules.golden.json"))
	require.NoError(t, err, "chunk-rules.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		HeadingPath []struct {
			Name  string `json:"name"`
			Input struct {
				Heading     string  `json:"heading"`
				HeadingPath *string `json:"headingPath"`
				DocPath     string  `json:"docPath"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"headingPath"`
		VersionLabel []struct {
			Name  string `json:"name"`
			Input struct {
				SemVerLabel  *string `json:"semVerLabel"`
				Branch       *string `json:"branch"`
				DefaultBrand string  `json:"defaultBranch"`
			} `json:"input"`
			Expected *string `json:"expected"`
		} `json:"versionLabel"`
		Classify []struct {
			Name  string `json:"name"`
			Input struct {
				Content       string `json:"content"`
				HeadingPath   string `json:"headingPath"`
				BlueprintRole string `json:"blueprintRole"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"classify"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	t.Run("headingPath 规则对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.HeadingPath)
		for _, tc := range fixture.HeadingPath {
			got := transcription.ResolveHeadingPath(tc.Input.Heading, derefStrPtr(tc.Input.HeadingPath), tc.Input.DocPath)
			assert.Equal(t, tc.Expected, got, "case %s", tc.Name)
		}
	})

	t.Run("versionLabel 规则对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.VersionLabel)
		for _, tc := range fixture.VersionLabel {
			got := transcription.ResolveVersionLabel(derefStrPtr(tc.Input.SemVerLabel), derefStrPtr(tc.Input.Branch), tc.Input.DefaultBrand)
			assert.Equal(t, derefStrPtr(tc.Expected), got, "case %s", tc.Name)
		}
	})

	t.Run("classify 规则对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.Classify)
		for _, tc := range fixture.Classify {
			got := chunker.ClassifyChunk(tc.Input.Content, tc.Input.HeadingPath, tc.Input.BlueprintRole)
			assert.Equal(t, tc.Expected, got, "case %s", tc.Name)
		}
	})
}

// canonicalSanitizeLines sanitize 双实现对拍的规范化：
// 逐行 trim、丢空行、剩余行以空格连接为单一串、空属性引号归一。锁住安全语义
// （标签/属性/文本内容与顺序漂移必抓），显式容忍 remark 块级空白序列化差异
// （块间空行数/软换行并段——纯文本空间不可逐字复现，强行对齐会沦为补丁堆）。
func canonicalSanitizeLines(s string) string {
	s = strings.ReplaceAll(s, "=''", "=\"\"")
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			out = append(out, ln)
		}
	}
	return strings.Join(out, " ")
}

func TestSanitizeGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/sanitize.golden.json"))
	require.NoError(t, err, "sanitize.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Cases []struct {
			Name     string `json:"name"`
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		got, err := sanitize.SanitizeText(tc.Input)
		require.NoError(t, err, "case %s", tc.Name)
		assert.Equal(t,
			canonicalSanitizeLines(tc.Expected),
			canonicalSanitizeLines(got),
			"case %s: TS Sanitizer 与 goSanitizeText 语义漂移", tc.Name,
		)
	}
}

func TestSearchSnippetGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/search-snippet.golden.json"))
	require.NoError(t, err, "search-snippet.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Snippets []struct {
			Name  string `json:"name"`
			Input struct {
				Text   string `json:"text"`
				Query  string `json:"query"`
				MaxLen int    `json:"maxLen"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"snippets"`
		Titles []struct {
			Name  string `json:"name"`
			Input struct {
				Title   string `json:"title"`
				Path    string `json:"path"`
				Content string `json:"content"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"titles"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	t.Run("ExtractContextSnippet 对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.Snippets)
		for _, tc := range fixture.Snippets {
			t.Run(tc.Name, func(t *testing.T) {
				got := ogis.ExtractContextSnippet(tc.Input.Text, tc.Input.Query, tc.Input.MaxLen)
				assert.Equal(t, tc.Expected, got, "case %s: ExtractContextSnippet mismatch", tc.Name)
			})
		}
	})

	t.Run("ResolveDocTitle 对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.Titles)
		for _, tc := range fixture.Titles {
			t.Run(tc.Name, func(t *testing.T) {
				got := ogis.ResolveDocTitle(tc.Input.Title, tc.Input.Path, tc.Input.Content)
				assert.Equal(t, tc.Expected, got, "case %s: ResolveDocTitle mismatch", tc.Name)
			})
		}
	})
}

func TestMdxHealerGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/mdx-healer.golden.json"))
	require.NoError(t, err, "mdx-healer.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Cases []struct {
			Name     string `json:"name"`
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := mdx.HealSource(tc.Input)
			require.NoError(t, err, "case %s: goHealMdxSource returned error", tc.Name)
			assert.Equal(t, tc.Expected, got, "case %s: TS healMdxSource 与 goHealMdxSource 逐字不一致", tc.Name)
		})
	}
}

func TestTokenCounterGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/token-counter.golden.json"))
	require.NoError(t, err, "token-counter.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		EstimateCases []struct {
			Name  string `json:"name"`
			Input struct {
				Text string `json:"text"`
			} `json:"input"`
			Expected int `json:"expected"`
		} `json:"estimateCases"`
		TruncateCases []struct {
			Name  string `json:"name"`
			Input struct {
				Text      string  `json:"text"`
				MaxTokens int     `json:"maxTokens"`
				Suffix    *string `json:"suffix"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"truncateCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	t.Run("EstimateTokens 数值对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.EstimateCases)
		for _, tc := range fixture.EstimateCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := doc.EstimateTokens(tc.Input.Text)
				assert.Equal(t, tc.Expected, got, "case %s: EstimateTokens 数值不一致", tc.Name)
			})
		}
	})

	t.Run("TruncateToTokenBudget 逐字对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.TruncateCases)
		for _, tc := range fixture.TruncateCases {
			t.Run(tc.Name, func(t *testing.T) {
				suffix := doc.DefaultTruncateSuffix
				if tc.Input.Suffix != nil {
					suffix = *tc.Input.Suffix
				}
				got := doc.TruncateToTokenBudget(tc.Input.Text, tc.Input.MaxTokens, suffix)
				assert.Equal(t, tc.Expected, got, "case %s: TruncateToTokenBudget 逐字不一致", tc.Name)
			})
		}
	})
}

func TestUpdateCandidateGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/update-candidate.golden.json"))
	require.NoError(t, err, "update-candidate.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Cases []struct {
			Name     string                         `json:"name"`
			Input    update.UpdateCandidateRequest  `json:"input"`
			Expected update.UpdateCandidateResponse `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := update.BuildUpdateCandidateSet(update.Config{}, tc.Input)
			require.NoError(t, err, "case %s: BuildUpdateCandidateSet error", tc.Name)
			require.NotNil(t, got, "case %s: nil response", tc.Name)

			gotJSON, err := json.Marshal(got)
			require.NoError(t, err)
			wantJSON, err := json.Marshal(tc.Expected)
			require.NoError(t, err)
			assert.JSONEq(t, string(wantJSON), string(gotJSON), "case %s: candidate set parity mismatch", tc.Name)
		})
	}
}

func TestDiffUnifiedGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/diff-unified.golden.json"))
	require.NoError(t, err, "diff-unified.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Version int `json:"version"`
		Cases   []struct {
			Name  string `json:"name"`
			Input struct {
				OldText      string  `json:"oldText"`
				NewText      string  `json:"newText"`
				OldPath      *string `json:"oldPath"`
				NewPath      *string `json:"newPath"`
				ContextLines *int    `json:"contextLines"`
			} `json:"input"`
			Expected diff.UnifiedDiffResult `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := diff.ComputeMyersDiff(tc.Input.OldText, tc.Input.NewText, tc.Input.OldPath, tc.Input.NewPath, tc.Input.ContextLines)
			assert.Equal(t, tc.Expected.Additions, got.Additions, "case %s additions", tc.Name)
			assert.Equal(t, tc.Expected.Deletions, got.Deletions, "case %s deletions", tc.Name)
			assert.Equal(t, tc.Expected.Hunks, got.Hunks, "case %s hunks", tc.Name)
			assert.Equal(t, tc.Expected.Unified, got.Unified, "case %s unified", tc.Name)
		})
	}
}

func TestWebDocDiffGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/web-doc-diff.golden.json"))
	require.NoError(t, err, "web-doc-diff.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Version int `json:"version"`
		Cases   []struct {
			Name  string `json:"name"`
			Input struct {
				CurrentUrls map[string]string `json:"currentUrls"`
				PrevSitemap map[string]string `json:"prevSitemap"`
				NewEtag     string            `json:"newEtag"`
				RootUrl     string            `json:"rootUrl"`
			} `json:"input"`
			Expected webdoc.WebDocDiffResult `json:"expected"`
		} `json:"cases"`
		XmlCases []struct {
			Name                  string            `json:"name"`
			Xml                   string            `json:"xml"`
			ExpectedUrls          map[string]string `json:"expectedUrls"`
			ExpectedChildSitemaps []string          `json:"expectedChildSitemaps"`
		} `json:"xmlCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	t.Run("Diff 算法双端对拍", func(t *testing.T) {
		for _, tc := range fixture.Cases {
			t.Run(tc.Name, func(t *testing.T) {
				got := webdoc.ComputeWebDocDiff(tc.Input.CurrentUrls, tc.Input.PrevSitemap, tc.Input.NewEtag, tc.Input.RootUrl)
				assert.Equal(t, tc.Expected.HasChanges, got.HasChanges, "case %s HasChanges", tc.Name)
				assert.Equal(t, tc.Expected.TotalChanged, got.TotalChanged, "case %s TotalChanged", tc.Name)
				assert.Equal(t, tc.Expected.TotalPages, got.TotalPages, "case %s TotalPages", tc.Name)
				assert.Equal(t, tc.Expected.PagesToAdd, got.PagesToAdd, "case %s PagesToAdd", tc.Name)
				assert.Equal(t, tc.Expected.PagesToUpdate, got.PagesToUpdate, "case %s PagesToUpdate", tc.Name)
				assert.Equal(t, tc.Expected.PagesToRemove, got.PagesToRemove, "case %s PagesToRemove", tc.Name)
			})
		}
	})

	t.Run("XML 流式解析双端对拍", func(t *testing.T) {
		for _, tc := range fixture.XmlCases {
			t.Run(tc.Name, func(t *testing.T) {
				urls, childSitemaps, err := webdoc.ParseSitemapXML(strings.NewReader(tc.Xml))
				require.NoError(t, err)
				assert.Equal(t, tc.ExpectedUrls, urls)
				if len(tc.ExpectedChildSitemaps) == 0 {
					assert.Empty(t, childSitemaps)
				} else {
					assert.Equal(t, tc.ExpectedChildSitemaps, childSitemaps)
				}
			})
		}
	})
}

func TestWebDocFastPathGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/web-doc-fastpath.golden.json"))
	require.NoError(t, err, "web-doc-fastpath.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Version         int `json:"version"`
		StripTitleCases []struct {
			RawTitle string `json:"rawTitle"`
			Expected string `json:"expected"`
		} `json:"stripTitleCases"`
		CanonicalPathCases []struct {
			RawUrl   string `json:"rawUrl"`
			Expected string `json:"expected"`
		} `json:"canonicalPathCases"`
		HeadingCases []struct {
			Name     string `json:"name"`
			Input    string `json:"input"`
			Expected []struct {
				Level int    `json:"level"`
				Text  string `json:"text"`
				ID    string `json:"id"`
			} `json:"expected"`
		} `json:"headingCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.StripTitleCases)

	t.Run("StripSiteTitleSuffix 标题剥离对拍", func(t *testing.T) {
		for _, tc := range fixture.StripTitleCases {
			got := webdoc.StripSiteTitleSuffix(tc.RawTitle)
			assert.Equal(t, tc.Expected, got, "StripSiteTitleSuffix(%q)", tc.RawTitle)
		}
	})

	t.Run("CanonicalDocPathFromUrl 路径规范化对拍", func(t *testing.T) {
		for _, tc := range fixture.CanonicalPathCases {
			got := webdoc.CanonicalDocPathFromUrl(tc.RawUrl)
			assert.Equal(t, tc.Expected, got, "CanonicalDocPathFromUrl(%q)", tc.RawUrl)
		}
	})

	t.Run("ExtractHeadingsFromMarkdown 大纲提取对拍", func(t *testing.T) {
		for _, tc := range fixture.HeadingCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := scout.ExtractHeadingsFromMarkdown(tc.Input)
				require.Equal(t, len(tc.Expected), len(got))
				for i := range tc.Expected {
					assert.Equal(t, tc.Expected[i].Level, got[i].Level)
					assert.Equal(t, tc.Expected[i].Text, got[i].Text)
					assert.Equal(t, tc.Expected[i].ID, got[i].ID)
				}
			})
		}
	})
}

func TestCognitiveProjectorGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/cognitive-projector.golden.json"))
	require.NoError(t, err, "cognitive-projector.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Version        int `json:"version"`
		PhaseVoteCases []struct {
			Name  string `json:"name"`
			Input struct {
				Files   []cognitive.PhaseVoteFile  `json:"files"`
				Options cognitive.PhaseVoteOptions `json:"options"`
			} `json:"input"`
			Expected struct {
				Phase      cognitive.CognitivePhase `json:"phase"`
				PhaseOrder int                      `json:"phaseOrder"`
				Rationale  string                   `json:"rationale"`
			} `json:"expected"`
		} `json:"phaseVoteCases"`
		ProjectCases []struct {
			Name  string `json:"name"`
			Input struct {
				Graph struct {
					NodeList      []rsg.SemanticGraphArtifactNode `json:"nodeList"`
					Edges         []rsg.SemanticGraphEdge         `json:"edges"`
					SoftEdges     []rsg.SoftGraphEdge             `json:"softEdges"`
					GoldenSymbols []rsg.GoldenSymbol              `json:"goldenSymbols"`
					CallEdges     []rsg.CallEdge                  `json:"callEdges"`
				} `json:"graph"`
				Modules []cognitive.ModuleDraftInput `json:"modules"`
				Options cognitive.PhaseVoteOptions   `json:"options"`
			} `json:"input"`
			Expected []cognitive.ProjectedModule `json:"expected"`
		} `json:"projectCases"`
		ScaffoldCases []struct {
			Name  string `json:"name"`
			Input struct {
				Cognitive     cognitive.ModuleCognition `json:"cognitive"`
				TeachingOrder int                       `json:"teachingOrder"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"scaffoldCases"`
		PromptScaffoldCases []struct {
			Name  string `json:"name"`
			Input struct {
				Modules []cognitive.ProjectedModule `json:"modules"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"promptScaffoldCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.PhaseVoteCases)

	t.Run("DetermineModuleCognitivePhase 相位判定对拍", func(t *testing.T) {
		for _, tc := range fixture.PhaseVoteCases {
			t.Run(tc.Name, func(t *testing.T) {
				phase, order, rationale := cognitive.DetermineModuleCognitivePhase(tc.Input.Files, tc.Input.Options)
				assert.Equal(t, tc.Expected.Phase, phase)
				assert.Equal(t, tc.Expected.PhaseOrder, order)
				assert.Equal(t, tc.Expected.Rationale, rationale)
			})
		}
	})

	t.Run("ProjectToCognitiveGradient 完整四阶投影对拍", func(t *testing.T) {
		for _, tc := range fixture.ProjectCases {
			t.Run(tc.Name, func(t *testing.T) {
				artifact := &rsg.SemanticGraphArtifact{
					Nodes:         tc.Input.Graph.NodeList,
					Edges:         tc.Input.Graph.Edges,
					SoftEdges:     tc.Input.Graph.SoftEdges,
					GoldenSymbols: tc.Input.Graph.GoldenSymbols,
					CallEdges:     tc.Input.Graph.CallEdges,
				}
				got := cognitive.ProjectToCognitiveGradient(artifact, tc.Input.Modules, tc.Input.Options)
				require.Equal(t, len(tc.Expected), len(got))
				for i := range tc.Expected {
					assert.Equal(t, tc.Expected[i].Name, got[i].Name, "module %d name", i)
					assert.Equal(t, tc.Expected[i].Phase, got[i].Phase, "module %d phase", i)
					assert.Equal(t, tc.Expected[i].PhaseOrder, got[i].PhaseOrder, "module %d phaseOrder", i)
					assert.Equal(t, tc.Expected[i].TeachingOrder, got[i].TeachingOrder, "module %d teachingOrder", i)
					assert.Equal(t, tc.Expected[i].BackboneCount, got[i].BackboneCount, "module %d backboneCount", i)
					assert.Equal(t, tc.Expected[i].EntryPointCount, got[i].EntryPointCount, "module %d entryPointCount", i)
					assert.InDelta(t, tc.Expected[i].AveragePageRank, got[i].AveragePageRank, 1e-9, "module %d avgPr", i)
					assert.Equal(t, tc.Expected[i].UpstreamModules, got[i].UpstreamModules, "module %d upstream", i)
					assert.Equal(t, tc.Expected[i].DownstreamModules, got[i].DownstreamModules, "module %d downstream", i)
				}
			})
		}
	})

	t.Run("BuildCognitiveScaffoldSection 脚手架对拍", func(t *testing.T) {
		for _, tc := range fixture.ScaffoldCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.BuildCognitiveScaffoldSection(tc.Input.Cognitive, tc.Input.TeachingOrder)
				assert.Equal(t, tc.Expected, got)
			})
		}
	})

	t.Run("BuildCognitivePromptScaffold 提示词脚手架对拍", func(t *testing.T) {
		for _, tc := range fixture.PromptScaffoldCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.BuildCognitivePromptScaffold(tc.Input.Modules)
				assert.Equal(t, tc.Expected, got)
			})
		}
	})
}

func TestFactGroundingGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/fact-grounding.golden.json"))
	require.NoError(t, err, "fact-grounding.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Version            int `json:"version"`
		FileGroundingCases []struct {
			Name  string `json:"name"`
			Input struct {
				ClaimedFiles []string                 `json:"claimedFiles"`
				Index        cognitive.GroundingIndex `json:"index"`
			} `json:"input"`
			Expected cognitive.GroundingVerdict `json:"expected"`
		} `json:"fileGroundingCases"`
		SymbolGroundingCases []struct {
			Name  string `json:"name"`
			Input struct {
				Claims []cognitive.SymbolClaim  `json:"claims"`
				Index  cognitive.GroundingIndex `json:"index"`
			} `json:"input"`
			Expected struct {
				GroundedSymbols     []cognitive.AlignedSymbol `json:"groundedSymbols"`
				HallucinatedSymbols []cognitive.SymbolClaim   `json:"hallucinatedSymbols"`
				Warnings            []string                  `json:"warnings"`
			} `json:"expected"`
		} `json:"symbolGroundingCases"`
		FactGroundingCases []struct {
			Name  string `json:"name"`
			Input struct {
				ClaimedFiles []string                 `json:"claimedFiles"`
				SymbolClaims []cognitive.SymbolClaim  `json:"symbolClaims"`
				Index        cognitive.GroundingIndex `json:"index"`
			} `json:"input"`
			Expected cognitive.GroundingReport `json:"expected"`
		} `json:"factGroundingCases"`
		ExtractClaimsCases []struct {
			Name  string `json:"name"`
			Input struct {
				MdxContent string `json:"mdxContent"`
			} `json:"input"`
			Expected []string `json:"expected"`
		} `json:"extractClaimsCases"`
		FeedbackCases []struct {
			Name  string `json:"name"`
			Input struct {
				Report cognitive.GroundingReport `json:"report"`
			} `json:"input"`
			Expected *string `json:"expected"`
		} `json:"feedbackCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.FileGroundingCases)

	t.Run("VerifyFileGrounding 路径校验对拍", func(t *testing.T) {
		for _, tc := range fixture.FileGroundingCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.VerifyFileGrounding(tc.Input.ClaimedFiles, tc.Input.Index)
				assert.Equal(t, tc.Expected.Valid, got.Valid, "Valid mismatch")
				assert.Equal(t, tc.Expected.GroundedFiles, got.GroundedFiles, "GroundedFiles mismatch")
				assert.Equal(t, tc.Expected.HallucinatedFiles, got.HallucinatedFiles, "HallucinatedFiles mismatch")
				assert.Equal(t, tc.Expected.AdjustedSourceFiles, got.AdjustedSourceFiles, "AdjustedSourceFiles mismatch")
				assert.Equal(t, tc.Expected.Warnings, got.Warnings, "Warnings mismatch")
			})
		}
	})

	t.Run("VerifySymbolGrounding 符号与行号对拍", func(t *testing.T) {
		for _, tc := range fixture.SymbolGroundingCases {
			t.Run(tc.Name, func(t *testing.T) {
				grounded, hallucinated, warnings := cognitive.VerifySymbolGrounding(tc.Input.Claims, tc.Input.Index)
				assert.Equal(t, tc.Expected.GroundedSymbols, grounded, "GroundedSymbols mismatch")
				assert.Equal(t, tc.Expected.HallucinatedSymbols, hallucinated, "HallucinatedSymbols mismatch")
				assert.Equal(t, tc.Expected.Warnings, warnings, "Warnings mismatch")
			})
		}
	})

	t.Run("VerifyFactGrounding 综合事实校验对拍", func(t *testing.T) {
		for _, tc := range fixture.FactGroundingCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.VerifyFactGrounding(tc.Input.ClaimedFiles, tc.Input.SymbolClaims, tc.Input.Index)
				assert.Equal(t, tc.Expected.Valid, got.Valid, "Valid mismatch")
				assert.Equal(t, tc.Expected.GroundedFiles, got.GroundedFiles, "GroundedFiles mismatch")
				assert.Equal(t, tc.Expected.HallucinatedFiles, got.HallucinatedFiles, "HallucinatedFiles mismatch")
				assert.Equal(t, tc.Expected.GroundedSymbols, got.GroundedSymbols, "GroundedSymbols mismatch")
				assert.Equal(t, tc.Expected.HallucinatedSymbols, got.HallucinatedSymbols, "HallucinatedSymbols mismatch")
				assert.Equal(t, tc.Expected.Warnings, got.Warnings, "Warnings mismatch")
			})
		}
	})

	t.Run("ExtractClaimedPathsFromMdx MDX提取对拍", func(t *testing.T) {
		for _, tc := range fixture.ExtractClaimsCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.ExtractClaimedPathsFromMdx(tc.Input.MdxContent)
				assert.Equal(t, tc.Expected, got)
			})
		}
	})

	t.Run("FormatGroundingFeedback 整改报告渲染对拍", func(t *testing.T) {
		for _, tc := range fixture.FeedbackCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := cognitive.FormatGroundingFeedback(tc.Input.Report)
				if tc.Expected == nil {
					assert.Nil(t, got)
				} else {
					require.NotNil(t, got)
					assert.Equal(t, *tc.Expected, *got)
				}
			})
		}
	})
}

// ─────────────────────────────────────────────────────────────
// Outline 启发式候选提取、规则保底大纲与防幻觉物理交集校验双端黄金对拍 (Unit 1.3)
// ─────────────────────────────────────────────────────────────

func TestOutlineCandidatesGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/outline-candidates.golden.json"))
	require.NoError(t, err, "outline-candidates.golden.json missing (frozen fixture, hand-maintained)")

	var cases []struct {
		Name  string `json:"name"`
		Input struct {
			MaxFiles int                 `json:"maxFiles"`
			Nodes    []cognitive.GitNode `json:"nodes"`
		} `json:"input"`
		Expected []cognitive.CandidateOutlineFile `json:"expected"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := cognitive.SelectCandidateFilesForOutline(tc.Input.Nodes, tc.Input.MaxFiles, patterns)
			assert.Equal(t, tc.Expected, got, "Candidate files mismatch in case %s", tc.Name)
		})
	}
}

func TestOutlineRuleFallbackGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/outline-rule-fallback.golden.json"))
	require.NoError(t, err, "outline-rule-fallback.golden.json missing (frozen fixture, hand-maintained)")

	var cases []struct {
		Name  string `json:"name"`
		Input struct {
			Prefix         string              `json:"prefix"`
			TargetLanguage string              `json:"targetLanguage"`
			Nodes          []cognitive.GitNode `json:"nodes"`
		} `json:"input"`
		Expected []cognitive.OutlineChapter `json:"expected"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := cognitive.BuildRuleFallbackOutline(tc.Input.Nodes, tc.Input.Prefix, tc.Input.TargetLanguage, patterns)
			assert.Equal(t, tc.Expected, got, "Rule fallback chapters mismatch in case %s", tc.Name)
		})
	}
}

func TestOutlineSanitizeGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/outline-sanitize.golden.json"))
	require.NoError(t, err, "outline-sanitize.golden.json missing (frozen fixture, hand-maintained)")

	var cases []struct {
		Name  string `json:"name"`
		Input struct {
			Prefix         string                           `json:"prefix"`
			TargetLanguage string                           `json:"targetLanguage"`
			CandidateFiles []cognitive.CandidateOutlineFile `json:"candidateFiles"`
			Nodes          []cognitive.GitNode              `json:"nodes"`
			Chapters       []cognitive.OutlineChapter       `json:"chapters"`
		} `json:"input"`
		Expected cognitive.SanitizeOutlineResult `json:"expected"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			candidateFiles := tc.Input.CandidateFiles
			if candidateFiles == nil {
				candidateFiles = []cognitive.CandidateOutlineFile{}
			}
			got := cognitive.SanitizeAndIntersectOutline(tc.Input.Chapters, tc.Input.Nodes, tc.Input.Prefix, tc.Input.TargetLanguage, candidateFiles, patterns)
			assert.Equal(t, tc.Expected.DroppedPaths, got.DroppedPaths, "DroppedPaths mismatch in case %s", tc.Name)
			assert.Equal(t, tc.Expected.Sanitized, got.Sanitized, "Sanitized chapters mismatch in case %s", tc.Name)
		})
	}
}

// 🧪 [4.3.1.2] TestConceptGoldenParity 跨仓对齐算法双端（TS / Go）固件逐字对拍一致性
func TestConceptGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/concept-engine.golden.json"))
	require.NoError(t, err, "concept-engine.golden.json missing (frozen fixture, hand-maintained)")

	var fixture struct {
		Skeleton struct {
			InputNodes       []concept.GitNode `json:"inputNodes"`
			ExtractedPaths   []string          `json:"extractedPaths"`
			Skeleton         string            `json:"skeleton"`
			SkeletonHash     string            `json:"skeletonHash"`
			IsComparable     bool              `json:"isComparable"`
			PromptInput      string            `json:"promptInput"`
			NormalizedPrompt string            `json:"normalizedPrompt"`
			FingerprintInput struct {
				Preset         string `json:"preset"`
				CustomPrompt   string `json:"customPrompt"`
				TargetLanguage string `json:"targetLanguage"`
				TeachingDepth  string `json:"teachingDepth"`
			} `json:"fingerprintInput"`
			Fingerprint string `json:"fingerprint"`
		} `json:"skeleton"`
		Heading struct {
			Cases []struct {
				Input         string `json:"input"`
				NormalizedKey string `json:"normalizedKey"`
				Slug          string `json:"slug"`
			} `json:"cases"`
			Anchors []struct {
				Heading     string  `json:"heading"`
				MatchedID   *string `json:"matchedId"`
				MatchedPath *string `json:"matchedPath"`
			} `json:"anchors"`
		} `json:"heading"`
		Manifest []struct {
			Name     string                          `json:"name"`
			Raw      string                          `json:"raw"`
			DocPath  string                          `json:"docPath"`
			Expected concept.ExtractedManifestResult `json:"expected"`
		} `json:"manifest"`
		Edges struct {
			Cooccurrence     []concept.DerivedEdge            `json:"cooccurrence"`
			Curriculum       []concept.DerivedEdge            `json:"curriculum"`
			Prioritized      []concept.DerivedEdge            `json:"prioritized"`
			FilterCandidates concept.FilterPrerequisiteResult `json:"filterCandidates"`
		} `json:"edges"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	t.Run("skeleton & fingerprint", func(t *testing.T) {
		sk := fixture.Skeleton
		gotPaths := concept.ExtractSkeletonPaths(sk.InputNodes, patterns)
		assert.Equal(t, sk.ExtractedPaths, gotPaths)
		gotSkeleton := concept.BuildSkeleton(sk.ExtractedPaths)
		assert.Equal(t, sk.Skeleton, gotSkeleton)
		assert.Equal(t, sk.SkeletonHash, concept.SkeletonHashOf(sk.Skeleton))
		assert.Equal(t, sk.IsComparable, concept.IsSkeletonComparable(sk.Skeleton))
		assert.Equal(t, sk.NormalizedPrompt, concept.NormalizePrompt(sk.PromptInput))
		assert.Equal(t, sk.Fingerprint, concept.BuildEditionFingerprint(
			sk.FingerprintInput.Preset,
			sk.FingerprintInput.CustomPrompt,
			sk.FingerprintInput.TargetLanguage,
			sk.FingerprintInput.TeachingDepth,
		))
	})

	t.Run("heading normalization & anchor match", func(t *testing.T) {
		for _, hc := range fixture.Heading.Cases {
			assert.Equal(t, hc.NormalizedKey, concept.NormalizeHeadingKey(hc.Input), "NormalizeHeadingKey(%s)", hc.Input)
			assert.Equal(t, hc.Slug, concept.SlugifyConcept(hc.Input), "SlugifyConcept(%s)", hc.Input)
		}

		h1 := "01_Overview"
		p1 := "overview"
		h2 := "Architecture > Core System"
		p2 := "architecture/core"
		h3 := "Guide (Part 1)"
		p3 := "guide"
		chunkCandidates := []concept.ChunkAnchorCandidate{
			{ID: "chunk-1", Heading: &h1, HeadingPath: &p1},
			{ID: "chunk-2", Heading: &h2, HeadingPath: &p2},
			{ID: "chunk-3", Heading: &h3, HeadingPath: &p3},
		}

		for _, ac := range fixture.Heading.Anchors {
			match := concept.MatchChunkAnchor(chunkCandidates, ac.Heading)
			if ac.MatchedID == nil {
				assert.Nil(t, match, "expected nil match for %s", ac.Heading)
			} else {
				require.NotNil(t, match, "expected match for %s", ac.Heading)
				assert.Equal(t, *ac.MatchedID, match.ID)
				if ac.MatchedPath != nil {
					require.NotNil(t, match.HeadingPath)
					assert.Equal(t, *ac.MatchedPath, *match.HeadingPath)
				}
			}
		}
	})

	t.Run("manifest extraction", func(t *testing.T) {
		for _, mc := range fixture.Manifest {
			got := concept.ExtractConceptManifest(mc.Raw, mc.DocPath)
			assert.Equal(t, mc.Expected.CleanContent, got.CleanContent, "CleanContent mismatch for %s", mc.Name)
			assert.Equal(t, mc.Expected.Summary, got.Summary, "Summary mismatch for %s", mc.Name)
			require.Equal(t, len(mc.Expected.Concepts), len(got.Concepts), "Concepts count mismatch for %s", mc.Name)
			for i := range mc.Expected.Concepts {
				assert.Equal(t, mc.Expected.Concepts[i], got.Concepts[i], "Concept %d mismatch in case %s", i, mc.Name)
			}
			assert.Equal(t, mc.Expected.Quizzes, got.Quizzes, "Quizzes mismatch for %s", mc.Name)
			assert.Equal(t, mc.Expected.Takeaways, got.Takeaways, "Takeaways mismatch for %s", mc.Name)
		}
	})

	t.Run("pure edges & prerequisite filter", func(t *testing.T) {
		strPtr := func(s string) *string { return &s }
		edgeConcepts := []concept.ConceptSeed{
			{ID: "node-1", ChunkID: strPtr("chk-1")},
			{ID: "node-2", ChunkID: strPtr("chk-1")},
			{ID: "node-3", ChunkID: strPtr("chk-1")},
			{ID: "node-4", ChunkID: strPtr("chk-2")},
		}
		gotCooc := concept.DeriveCooccurrenceEdges(edgeConcepts)
		assert.Equal(t, fixture.Edges.Cooccurrence, gotCooc)

		ordered := [][]string{{"node-1", "node-2"}, {"node-3", "node-4"}}
		gotCurr := concept.DeriveCurriculumOrderEdges(ordered)
		assert.Equal(t, fixture.Edges.Curriculum, gotCurr)

		gotPrioritized := concept.PrioritizeEdgesForBudget(gotCurr, gotCooc, 3)
		assert.Equal(t, fixture.Edges.Prioritized, gotPrioritized)

		candidates := []concept.DerivedEdge{
			{SourceID: "a", TargetID: "b", Type: "prerequisite", Weight: 1, Source: "llm"},
			{SourceID: "c", TargetID: "a", Type: "prerequisite", Weight: 1, Source: "llm"},
			{SourceID: "b", TargetID: "a", Type: "prerequisite", Weight: 1, Source: "llm"},
		}
		established := []concept.EdgeRef{
			{SourceID: "a", TargetID: "b", Type: "prerequisite", Weight: 1},
			{SourceID: "b", TargetID: "c", Type: "prerequisite", Weight: 1},
		}
		gotFilter := concept.FilterPrerequisiteCandidates(candidates, established)
		assert.Equal(t, fixture.Edges.FilterCandidates, gotFilter)
	})
}

type storeChunksGoldenFixture struct {
	QuizzesAndTakeaways []struct {
		Name  string `json:"name"`
		Input struct {
			DocPath   string                     `json:"docPath"`
			Concepts  []concept.ExtractedConcept `json:"concepts"`
			Quizzes   []concept.CompanionQuiz    `json:"quizzes"`
			Takeaways []string                   `json:"takeaways"`
		} `json:"input"`
		Expected []concept.ExtractedConcept `json:"expected"`
	} `json:"quizzes_and_takeaways"`
	Chunks []struct {
		ID          string  `json:"id"`
		Heading     *string `json:"heading"`
		HeadingPath *string `json:"headingPath"`
		Content     string  `json:"content"`
	} `json:"chunks"`
	AnchorDisambiguation []struct {
		ConceptName    string  `json:"conceptName"`
		SourceHeading  *string `json:"sourceHeading"`
		AnchorText     *string `json:"anchorText"`
		PrinciplesText string  `json:"principlesText"`
		Summary        string  `json:"summary"`
		Expected       struct {
			ChunkID        *string `json:"chunkId"`
			HeadingPath    *string `json:"headingPath"`
			PrinciplesText string  `json:"principlesText"`
		} `json:"expected"`
	} `json:"anchor_disambiguation"`
	Edges struct {
		CooccurrenceInput    []concept.ConceptSeed `json:"cooccurrence_input"`
		CooccurrenceExpected []concept.DerivedEdge `json:"cooccurrence_expected"`
		CurriculumInput      [][]string            `json:"curriculum_input"`
		CurriculumExpected   []concept.DerivedEdge `json:"curriculum_expected"`
	} `json:"edges"`
}

func TestStoreChunksGoldenParity(t *testing.T) {
	// 2.12.10.1 存储前段与图谱边双端 100% 黄金对拍
	data, err := os.ReadFile(findTestData("testdata/store-chunks.golden.json"))
	require.NoError(t, err)

	var fixture storeChunksGoldenFixture
	require.NoError(t, json.Unmarshal(data, &fixture))

	t.Run("quizzes and takeaways injection parity", func(t *testing.T) {
		for _, tc := range fixture.QuizzesAndTakeaways {
			got := transcription.ApplyQuizzesAndTakeaways(tc.Input.Concepts, tc.Input.Quizzes, tc.Input.Takeaways, tc.Input.DocPath)
			require.Equal(t, len(tc.Expected), len(got), "count mismatch for %s", tc.Name)
			for i := range tc.Expected {
				assert.Equal(t, tc.Expected[i].ConceptName, got[i].ConceptName, "ConceptName %d in %s", i, tc.Name)
				assert.Equal(t, tc.Expected[i].Category, got[i].Category, "Category %d in %s", i, tc.Name)
				assert.Equal(t, tc.Expected[i].Slug, got[i].Slug, "Slug %d in %s", i, tc.Name)
				assert.Equal(t, tc.Expected[i].AuthorReflections, got[i].AuthorReflections, "AuthorReflections %d in %s", i, tc.Name)
			}
		}
	})

	t.Run("anchor disambiguation and principles enrichment parity", func(t *testing.T) {
		chunks := make([]transcription.DocChunkRow, len(fixture.Chunks))
		for i, c := range fixture.Chunks {
			chunks[i] = transcription.DocChunkRow{
				ID:          c.ID,
				Heading:     c.Heading,
				HeadingPath: c.HeadingPath,
				Content:     c.Content,
			}
		}

		for _, ac := range fixture.AnchorDisambiguation {
			var sh string
			if ac.SourceHeading != nil {
				sh = *ac.SourceHeading
			}
			var at string
			if ac.AnchorText != nil {
				at = *ac.AnchorText
			}
			item := concept.ExtractedConcept{
				ConceptName:    ac.ConceptName,
				SourceHeading:  sh,
				AnchorText:     at,
				PrinciplesText: ac.PrinciplesText,
				Summary:        ac.Summary,
			}
			cid, path, matched := transcription.ResolveConceptChunkAnchor(item, chunks)
			if ac.Expected.ChunkID == nil {
				assert.Nil(t, cid, "expected nil chunkId for %s", ac.ConceptName)
			} else {
				require.NotNil(t, cid, "expected non-nil chunkId for %s", ac.ConceptName)
				assert.Equal(t, *ac.Expected.ChunkID, *cid, "chunkId for %s", ac.ConceptName)
			}

			if ac.Expected.HeadingPath == nil {
				assert.Nil(t, path, "expected nil headingPath for %s", ac.ConceptName)
			} else {
				require.NotNil(t, path, "expected non-nil headingPath for %s", ac.ConceptName)
				assert.Equal(t, *ac.Expected.HeadingPath, *path, "headingPath for %s", ac.ConceptName)
			}

			enriched := transcription.EnrichPrinciplesText(item, cid, matched)
			assert.Equal(t, ac.Expected.PrinciplesText, enriched, "principlesText for %s", ac.ConceptName)
		}
	})

	t.Run("edge derivation parity", func(t *testing.T) {
		cooc := concept.DeriveCooccurrenceEdges(fixture.Edges.CooccurrenceInput)
		assert.Equal(t, fixture.Edges.CooccurrenceExpected, cooc)

		curr := concept.DeriveCurriculumOrderEdges(fixture.Edges.CurriculumInput)
		assert.Equal(t, fixture.Edges.CurriculumExpected, curr)
	})
}

// 🧪 [3.6.1.1 · CRITICAL] 双端浮点运算次序漂移导致进度数字跳变
// TestReadingFingerprintGoldenParity 阅读指纹（Unit 3.6）双实现对拍：
// TS 为契约事实源；Go 端任何浮点运算次序/舍入时机漂移都会在此逐位变红。
func TestReadingFingerprintGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/reading-fingerprint.golden.json"))
	require.NoError(t, err, "reading-fingerprint.golden.json missing (frozen contract fixture)")

	var fixture struct {
		Cases []struct {
			Name     string                                `json:"name"`
			Input    fingerprint.FingerprintComputeRequest `json:"input"`
			Expected fingerprint.FingerprintProgress       `json:"expected"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			require.NotNil(t, tc.Input.Config, "fixture config must be present")
			got := fingerprint.ComputeFingerprint(tc.Input.Chapters, tc.Input.Events, tc.Input.Config)
			assert.Equal(t, tc.Expected, got, "TS computeReadingFingerprint 与 Go ComputeFingerprint 语义漂移")
		})
	}
}

// TestArmorGoldenParity 转录确定性装甲三件套（M02 中段下沉）双实现对拍：
// TS 为契约事实源；JS 前瞻/后顾正则的 RE2 等价改写若语义漂移在此逐字变红。
// 🧪 向量 2.16.1.1: armor.golden.json 22 案例双端逐字对拍（含 7# 非边界、L0 真值、双名交叉闭合、代码块原样）
func TestArmorGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/armor.golden.json"))
	require.NoError(t, err, "armor.golden.json missing (frozen contract fixture)")

	var fixture struct {
		ResolveHandles []struct {
			Name     string                           `json:"name"`
			Input    armor.ArmorResolveHandlesRequest `json:"input"`
			Expected string                           `json:"expected"`
		} `json:"resolveHandles"`
		Sanitize []struct {
			Name     string                     `json:"name"`
			Input    armor.ArmorSanitizeRequest `json:"input"`
			Expected string                     `json:"expected"`
		} `json:"sanitize"`
		Allocate []struct {
			Name     string                        `json:"name"`
			Input    armor.ArmorAllocateRequest    `json:"input"`
			Expected []armor.ArmorAllocatedSnippet `json:"expected"`
		} `json:"allocate"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.ResolveHandles)
	require.NotEmpty(t, fixture.Sanitize)
	require.NotEmpty(t, fixture.Allocate)

	t.Run("resolveHandles 对拍", func(t *testing.T) {
		for _, tc := range fixture.ResolveHandles {
			got := armor.ResolveFileHandles(tc.Input.MdxContent, tc.Input.Files)
			assert.Equal(t, tc.Expected, got, "case %s: TS resolveFileHandles 与 Go ResolveFileHandles 漂移", tc.Name)
		}
	})

	t.Run("sanitize 对拍", func(t *testing.T) {
		for _, tc := range fixture.Sanitize {
			got := armor.SanitizeMdxForCompilation(tc.Input.MdxContent)
			assert.Equal(t, tc.Expected, got, "case %s: TS sanitizeMdxForCompilation 与 Go 漂移", tc.Name)
		}
	})

	t.Run("allocate 对拍", func(t *testing.T) {
		for _, tc := range fixture.Allocate {
			got := armor.AllocateBalancedSourceSnippets(tc.Input.Files, tc.Input.TotalBudgetChars)
			assert.Equal(t, tc.Expected, got, "case %s: TS allocateBalancedSourceSnippets 与 Go 漂移", tc.Name)
		}
	})
}

func loadChapterMapPatterns(t *testing.T) *ingest.IngestPatterns {
	t.Helper()
	p := ingest.DefaultPatterns()
	require.NotNil(t, p)
	return p
}

// TestChapterMapGoldenParity 章节映射确定性引擎（教材分流）双实现对拍：
// TS 为契约事实源；自然排序/locale 近似/TOC 链接解析/防幻觉校验的语义漂移在此逐字段变红。
func TestChapterMapGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findTestData("testdata/chapter-map.golden.json"))
	require.NoError(t, err, "chapter-map.golden.json missing (frozen contract fixture)")

	var fixture struct {
		Signal []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes      []chapter.ChapterMapNode `json:"nodes"`
				TocContent string                   `json:"tocContent"`
				ReadmeHead string                   `json:"readmeHead"`
				Prefix     string                   `json:"prefix"`
			} `json:"input"`
			Expected chapter.OrderSignal `json:"expected"`
		} `json:"signal"`
		Candidates []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes    []chapter.ChapterMapNode `json:"nodes"`
				TextRoot string                   `json:"textRoot"`
			} `json:"input"`
			Expected chapter.ChapterCandidates `json:"expected"`
		} `json:"candidates"`
		Validate []struct {
			Name  string `json:"name"`
			Input struct {
				Raw   json.RawMessage          `json:"raw"`
				Nodes []chapter.ChapterMapNode `json:"nodes"`
			} `json:"input"`
			Expected *[]chapter.ChapterMapEntry `json:"expected"`
		} `json:"validate"`
		TocPath []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes    []chapter.ChapterMapNode `json:"nodes"`
				TextRoot string                   `json:"textRoot"`
			} `json:"input"`
			Expected *string `json:"expected"`
		} `json:"tocPath"`
		FromSidecar []struct {
			Name  string `json:"name"`
			Input struct {
				Content  string                   `json:"content"`
				Nodes    []chapter.ChapterMapNode `json:"nodes"`
				TextRoot string                   `json:"textRoot"`
			} `json:"input"`
			Expected *[]chapter.ChapterMapEntry `json:"expected"`
		} `json:"fromSidecar"`
		TextbookSignal []struct {
			Name  string `json:"name"`
			Input struct {
				Profile *chapter.TextbookRepoProfile `json:"profile"`
				Nodes   []chapter.ChapterMapNode     `json:"nodes"`
			} `json:"input"`
			Expected bool `json:"expected"`
		} `json:"textbookSignal"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Signal)
	require.NotEmpty(t, fixture.Candidates)
	require.NotEmpty(t, fixture.Validate)
	require.NotEmpty(t, fixture.TocPath)
	require.NotEmpty(t, fixture.FromSidecar)

	p := loadChapterMapPatterns(t)

	t.Run("signal 对拍", func(t *testing.T) {
		for _, tc := range fixture.Signal {
			got := p.DetectOrderSignal(tc.Input.Nodes, tc.Input.TocContent, tc.Input.ReadmeHead, tc.Input.Prefix)
			assert.Equal(t, tc.Expected, got, "case %s: TS detectOrderSignal 与 Go 漂移", tc.Name)
		}
	})

	t.Run("candidates 对拍", func(t *testing.T) {
		for _, tc := range fixture.Candidates {
			got := p.BuildChapterCandidates(tc.Input.Nodes, tc.Input.TextRoot)
			assert.Equal(t, tc.Expected, got, "case %s: TS buildChapterCandidates 与 Go 漂移", tc.Name)
		}
	})

	t.Run("validate 对拍", func(t *testing.T) {
		for _, tc := range fixture.Validate {
			got := p.ValidateChapterMap(tc.Input.Raw, tc.Input.Nodes)
			if tc.Expected == nil {
				assert.Nil(t, got, "case %s: 期望校验不过返回 nil", tc.Name)
			} else {
				require.NotNil(t, got, "case %s: 期望校验通过", tc.Name)
				assert.Equal(t, *tc.Expected, got, "case %s: TS validateChapterMap 与 Go 漂移", tc.Name)
			}
		}
	})

	t.Run("tocPath 对拍", func(t *testing.T) {
		for _, tc := range fixture.TocPath {
			got := p.FindTocSidecarPath(tc.Input.Nodes, tc.Input.TextRoot)
			if tc.Expected == nil {
				assert.Nil(t, got, "case %s: 期望无侧车", tc.Name)
			} else {
				require.NotNil(t, got, "case %s: 期望命中侧车", tc.Name)
				assert.Equal(t, *tc.Expected, *got, "case %s: TS findTocSidecarPath 与 Go 漂移", tc.Name)
			}
		}
	})

	t.Run("fromSidecar 对拍", func(t *testing.T) {
		for _, tc := range fixture.FromSidecar {
			got := p.ChapterMapFromSidecar(tc.Input.Content, tc.Input.Nodes, tc.Input.TextRoot)
			if tc.Expected == nil {
				assert.Nil(t, got, "case %s: 期望 null", tc.Name)
			} else {
				require.NotNil(t, got, "case %s: 期望非 null", tc.Name)
				assert.Equal(t, *tc.Expected, got, "case %s: TS chapterMapFromSidecar 与 Go 漂移", tc.Name)
			}
		}
	})

	t.Run("textbookSignal 对拍", func(t *testing.T) {
		for _, tc := range fixture.TextbookSignal {
			got := p.IsTextbookRepoSignal(tc.Input.Profile, tc.Input.Nodes)
			assert.Equal(t, tc.Expected, got, "case %s: TS isTextbookRepoSignal 与 Go 漂移", tc.Name)
		}
	})
}
