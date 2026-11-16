package webdoc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockProbeLLM struct {
	payload string
	err     error
	calls   int
}

func (m *mockProbeLLM) Generate(_ context.Context, _ string, _ map[string]any, _ *string, target any) error {
	m.calls++
	if m.err != nil {
		return m.err
	}
	return json.Unmarshal([]byte(m.payload), target)
}

func TestContainerProbeAndDeterministicReplay(t *testing.T) {
	bentoHTML := loadParityFixtureHTML(t, "bento_custom_cards.html")

	t.Run("extracts_sanitized_bento_skeleton_and_truncates_long_text", func(t *testing.T) {
		skeletons := ExtractDegradedContainerSkeletons([]string{bentoHTML}, 6)
		require.NotEmpty(t, skeletons)
		foundBento := false
		for _, sk := range skeletons {
			if sk.Signature == "div.bento-tile" {
				foundBento = true
				assert.Equal(t, 2, sk.Count)
				assert.Contains(t, sk.MinimalHTML, `class="bento-tile"`)
			}
		}
		assert.True(t, foundBento, "expected div.bento-tile skeleton to be extracted")
	})

	t.Run("probe_validates_selectors_rejects_bare_tags_and_replays_through_conservation_gate", func(t *testing.T) {
		llm := &mockProbeLLM{
			payload: `{
				"rules": [
					{
						"containerSelector": "div",
						"role": "card",
						"titleSelector": ".bento-heading"
					},
					{
						"containerSelector": "div.bento-tile",
						"role": "card",
						"eyebrowSelector": ".bento-tag",
						"titleSelector": ".bento-heading",
						"bodySelector": ".bento-desc",
						"linkSelector": ".bento-cta"
					},
					{
						"containerSelector": "div.custom-banner-notice",
						"role": "callout",
						"calloutType": "info",
						"titleSelector": ".custom-banner-title",
						"bodySelector": ".custom-banner-copy"
					}
				]
			}`,
		}

		skeletons := ExtractDegradedContainerSkeletons([]string{bentoHTML}, 6)
		rules := ProbeSiteContainerMappings(context.Background(), llm, "https://example.com/docs/bento", skeletons, 4, nil)
		assert.Equal(t, 1, llm.calls)
		require.Len(t, rules, 2)
		assert.Equal(t, "div.bento-tile", rules[0].ContainerSelector)
		assert.Equal(t, "div.custom-banner-notice", rules[1].ContainerSelector)

		docs := []FirecrawlDoc{{
			Path:     "docs/bento.md",
			Title:    "Custom Bento Showcase",
			Markdown: "placeholder markdown before probe replay",
			URL:      "https://example.com/docs/bento",
			Metadata: map[string]any{
				"rawHtml": bentoHTML,
			},
		}}

		updated, applied := ApplySiteContainerRulesToDocs(docs, rules)
		assert.GreaterOrEqual(t, applied, 3)
		require.Len(t, updated, 1)
		md := updated[0].Markdown
		assert.Contains(t, md, "<CardGroup")
		assert.Contains(t, md, `title="Event Workflows"`)
		assert.Contains(t, md, `eyebrow="Automation"`)
		assert.Contains(t, md, `href="/docs/workflows/events"`)
		assert.Contains(t, md, `title="Execution Ledger"`)
		assert.Contains(t, md, `<Callout type="info" title="Platform Beta Notice">`)
	})

	t.Run("fail_closed_when_probed_selector_causes_text_loss", func(t *testing.T) {
		badRule := []ContainerMappingRule{{
			ContainerSelector: "div.bento-tile",
			Role:              "card",
			TitleSelector:     ".bento-heading",
			BodySelector:      ".nonexistent-empty-body",
		}}
		// Even with TitleSelector removing heading and nonexistent BodySelector, fallback keeps remaining children,
		// so test explicitly with a rule that would only capture heading via custom container having extra sibling lost?
		// Better: test liftCustomCalloutByRule directly or a container whose TitleSelector leaves empty body -> returns false & leaves markdown untouched
		docs := []FirecrawlDoc{{
			Path:     "docs/bento.md",
			Title:    "Custom Bento Showcase",
			Markdown: "ORIGINAL_SAFE_MARKDOWN",
			URL:      "https://example.com/docs/bento",
			Metadata: map[string]any{
				"rawHtml": `<html><body><main><h1>Title</h1><p>This site renders custom markup below.</p><div class="only-title"><span class="t">Only Title Without Body</span></div></main></body></html>`,
			},
		}}
		emptyBodyCallout := []ContainerMappingRule{{
			ContainerSelector: "div.only-title",
			Role:              "callout",
			TitleSelector:     ".t",
		}}
		updated, applied := ApplySiteContainerRulesToDocs(docs, emptyBodyCallout)
		assert.Equal(t, 0, applied)
		assert.Equal(t, "ORIGINAL_SAFE_MARKDOWN", updated[0].Markdown)
		_ = badRule
	})

	t.Run("rejects_comma_separated_bare_tag_bypass", func(t *testing.T) {
		llm := &mockProbeLLM{
			payload: `{
				"rules": [
					{"containerSelector": "div.bento-tile, div", "role": "card", "titleSelector": ".bento-heading"},
					{"containerSelector": "div.bento-tile, *", "role": "card", "titleSelector": ".bento-heading"}
				]
			}`,
		}
		skeletons := ExtractDegradedContainerSkeletons([]string{bentoHTML}, 6)
		rules := ProbeSiteContainerMappings(context.Background(), llm, "https://example.com/docs/bento", skeletons, 4, nil)
		assert.Empty(t, rules)
	})

	t.Run("single_matched_custom_card_emits_standalone_card_without_cols_1", func(t *testing.T) {
		singleHTML := `<!DOCTYPE html><html><body><main><h1>Single Custom Tile</h1><p>This custom container showcases one feature block without any grid wrapper around sibling cards.</p><div class="bento-tile"><span class="bento-tag">Core</span><div class="bento-heading">Single Tile</div><p class="bento-desc">Standalone custom bento tile with full conservation.</p><a class="bento-cta" href="/docs/single">Read more</a></div></main></body></html>`
		docs := []FirecrawlDoc{{
			Path:     "docs/single.md",
			Title:    "Single Custom Tile",
			Markdown: "placeholder",
			URL:      "https://example.com/docs/single",
			Metadata: map[string]any{"rawHtml": singleHTML},
		}}
		rules := []ContainerMappingRule{{
			ContainerSelector: "div.bento-tile",
			Role:              "card",
			EyebrowSelector:   ".bento-tag",
			TitleSelector:     ".bento-heading",
			BodySelector:      ".bento-desc",
			LinkSelector:      ".bento-cta",
		}}
		updated, applied := ApplySiteContainerRulesToDocs(docs, rules)
		assert.Equal(t, 1, applied)
		assert.Contains(t, updated[0].Markdown, `<Card title="Single Tile"`)
		assert.NotContains(t, updated[0].Markdown, `<CardGroup`)
		assert.NotContains(t, updated[0].Markdown, "[Read more](/docs/single)")
	})
}
