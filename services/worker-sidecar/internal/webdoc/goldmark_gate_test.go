package webdoc

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDegradeFlattenedLinksWithGoldmark(t *testing.T) {
	tests := []struct {
		name           string
		input          string
		wantRewrites   int
		mustContain    []string
		mustNotContain []string
	}{
		{
			name:           "preserves_pure_badge_image_link_and_short_inline_link",
			input:          "[![Build Passing](https://img.shields.io/badge/build-passing-green)](https://github.com/acme/repo)\n\nRead the [Quickstart Guide](/docs/quickstart) for details.",
			wantRewrites:   0,
			mustContain:    []string{"[![Build Passing](https://img.shields.io/badge/build-passing-green)](https://github.com/acme/repo)", "[Quickstart Guide](/docs/quickstart)"},
			mustNotContain: []string{"> **["},
		},
		{
			name:           "degrades_multiline_card_link_to_quote_card",
			input:          "See our integration options below:\n\n[Slack Workflows\nRoute support alerts and automate incident triage across channels.](/docs/integrations/slack)\n\nNext section continues here.",
			wantRewrites:   1,
			mustContain:    []string{"> **[Slack Workflows →](/docs/integrations/slack)**", "> Route support alerts and automate incident triage across channels.", "Next section continues here."},
			mustNotContain: []string{"Route support alerts and automate incident triage across channels.](/docs/integrations/slack)"},
		},
		{
			name:           "degrades_hard_linebreak_card_link_to_quote_card",
			input:          "[Slack Alerts  \nForward critical pager notifications immediately.](/docs/alerts)",
			wantRewrites:   1,
			mustContain:    []string{"> **[Slack Alerts →](/docs/alerts)**", "> Forward critical pager notifications immediately."},
			mustNotContain: []string{"Forward critical pager notifications immediately.](/docs/alerts)"},
		},
		{
			name:           "degrades_overlong_single_line_anchor_preserving_text",
			input:          "[" + strings.Repeat("Deploy resilient AI agent workflows across distributed clusters and monitor live tool execution metrics ", 2) + "](/docs/workflows/scale)",
			wantRewrites:   1,
			mustContain:    []string{"> **[Deploy resilient AI agent workflows", "→](/docs/workflows/scale)**", "distributed clusters"},
			mustNotContain: []string{"metrics ](/docs/workflows/scale)"},
		},
		{
			name:           "preserves_long_links_inside_gfm_table_cells",
			input:          "| Capability | Reference |\n| --- | --- |\n| Distributed Workflows | [" + strings.Repeat("Long table description text preserved inline without corrupting table cell formatting ", 2) + "](/docs/table-ref) |",
			wantRewrites:   0,
			mustContain:    []string{"| Distributed Workflows | [", "](/docs/table-ref) |"},
			mustNotContain: []string{"> **["},
		},
		{
			name:           "strips_edit_chrome_lines_outside_code_but_protects_fenced_code",
			input:          "Intro paragraph.\n\n[Edit this page on GitHub](https://github.com/acme/docs/edit/main/intro.md)\n\nCopy page\n\n```md\n[Edit this page on GitHub](https://github.com/acme/docs/edit/main/intro.md)\n[Line one\nLine two](/docs/sample)\n```",
			wantRewrites:   2,
			mustContain:    []string{"Intro paragraph.", "```md\n[Edit this page on GitHub](https://github.com/acme/docs/edit/main/intro.md)\n[Line one\nLine two](/docs/sample)\n```"},
			mustNotContain: []string{"\nCopy page\n", "Edit this page on GitHub](https://github.com/acme/docs/edit/main/intro.md)\n\n```"},
		},
		{
			name:           "idempotent_on_already_degraded_long_quote_card",
			input:          "> **[" + strings.Repeat("Very long workflow architecture title ", 5) + "→](/docs/long)**\n\nTrailing paragraph.",
			wantRewrites:   0,
			mustContain:    []string{"> **[Very long workflow architecture title", "→](/docs/long)**"},
			mustNotContain: []string{"> > **["},
		},
		{
			name:           "blockquote_multiline_link_degrades_without_double_prefix",
			input:          "> [Line one\n> Line two](/docs/bq)",
			wantRewrites:   1,
			mustContain:    []string{"> **[Line one →](/docs/bq)**", "> Line two"},
			mustNotContain: []string{"> >"},
		},
		{
			name:           "list_item_multiline_link_indents_continuation_cleanly",
			input:          "- [First line\n  Second line](/docs/li)",
			wantRewrites:   1,
			mustContain:    []string{"- > **[First line →](/docs/li)**", "\n  >\n  > Second line"},
			mustNotContain: []string{"> >"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, rewrites := DegradeFlattenedLinksWithGoldmark(tt.input)
			assert.Equal(t, tt.wantRewrites, rewrites)
			for _, want := range tt.mustContain {
				assert.Contains(t, out, want)
			}
			for _, forbid := range tt.mustNotContain {
				assert.NotContains(t, out, forbid)
			}
		})
	}
}

func TestGoldmarkGate_CodeMaskLengthNotInflated(t *testing.T) {
	input := "Integrate with [`a` · `b` · `c` · `d` · `e` · `f` · `g` · `h` · `i` · `j`](/docs/pills) in minutes."
	sanitized := SanitizeMarkdown("docs/pills.md", input)
	assert.Contains(t, sanitized, "[`a` · `b`")
	assert.NotContains(t, sanitized, "> **[")
}
