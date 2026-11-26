package webdoc

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

func loadParityFixtureHTML(t *testing.T, filename string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "html_parity", filename))
	require.NoError(t, err, "read parity fixture %s", filename)
	return string(b)
}

func scanFixtureHTML(t *testing.T, fixtureFile, reqPath string) (*FastPathScanResult, string) {
	t.Helper()
	rawHTML := loadParityFixtureHTML(t, fixtureFile)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(rawHTML))
	}))
	defer srv.Close()

	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	t.Cleanup(resetRobotsCache)

	res, err := ScanFastPathPage(context.Background(), srv.URL+reqPath, 0)
	require.NoError(t, err)
	require.NotNil(t, res)
	require.True(t, res.IsStatic, "fixture %s should pass static scan", fixtureFile)
	require.NotNil(t, res.Document)

	sanitized := SanitizeMarkdown(res.Document.Path, res.Document.Markdown)
	return res, sanitized
}

func assertNoFlattenedBrokenLinks(t *testing.T, fixtureName, md string) {
	t.Helper()
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
	src := []byte(md)
	doc := parser.Parser().Parse(text.NewReader(src))

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		link, ok := n.(*ast.Link)
		if !ok {
			return ast.WalkContinue, nil
		}
		if isInsideTableNode(link) || isImageOnlyGoldmarkLink(link, src) {
			return ast.WalkSkipChildren, nil
		}
		assert.Falsef(t, hasGoldmarkLinkBreak(link, src),
			"%s: found multiline/line-break *ast.Link destination=%s", fixtureName, string(link.Destination))
		plain := collectGoldmarkPlainText(link, src, nil)
		assert.LessOrEqualf(t, countNonSpaceRunes(plain), goldmarkMaxInlineLinkRunes,
			"%s: found overlong *ast.Link (%d runes) text=%q", fixtureName, countNonSpaceRunes(plain), plain)
		return ast.WalkSkipChildren, nil
	})
}

func TestHTMLParityGoldenCorpus(t *testing.T) {
	tests := []struct {
		name           string
		fixture        string
		reqPath        string
		mustContain    []string
		mustNotContain []string
		checkExtra     func(t *testing.T, res *FastPathScanResult, sanitized string)
	}{
		{
			name:    "01_eve_use_cases_cards_pills_svg_and_chrome",
			fixture: "eve_use_cases.html",
			reqPath: "/docs/use-cases",
			mustContain: []string{
				`<CardGroup cols="2">`,
				`<Card title="Business agents" eyebrow="For your team" href="#business-agents">`,
				`<Card title="Agent as a Service (AaaS)" eyebrow="For your customers" href="#agent-as-a-service-aaas">`,
				"`Slack` · `Microsoft Teams` · `GitHub` · `Linear` · `Web`",
				"`iMessage` · `WhatsApp` · `Telegram` · `Discord` · `Web`",
				"## Business agents",
				`<CardGroup cols="3">`,
				`<Card title="Software factory" href="https://github.com/vercel-labs/eve-software-factory-template/tree/main">`,
				"Software Factory template",
				`<Card title="Company brain" href="https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template">`,
				"Company Brain template",
				`<Card title="Marketing team" href="https://github.com/vercel-labs/marketing-team-eve-template/tree/main">`,
				"Marketing team template",
				"### How eve supports business agents",
				"Meet employees where they work",
				"[Channels](/docs/channels)",
				"npx eve@latest init my-agent",
			},
			mustNotContain: []string{
				"<svg",
				"ArrowRight",
				"ExternalArrow",
				"iMessageiMessage",
				"iMessage iMessage",
				"Web chat",
				"MotherDuck",
				"Edit this page on GitHub",
				"Copy page",
				"Scroll to top",
				"Give feedback",
				"On this page",
			},
			checkExtra: func(t *testing.T, res *FastPathScanResult, sanitized string) {
				assert.Equal(t, "Use Cases", res.Document.Title)
				assert.Equal(t, 2, res.Telemetry.CardGroupsLifted)
				assert.Equal(t, 5, res.Telemetry.CardsLifted)
				assert.GreaterOrEqual(t, res.Telemetry.SvgsStripped, 25)
				assert.Equal(t, 1, strings.Count(sanitized, "Notion"))
				assert.Equal(t, 1, strings.Count(sanitized, "Resend"))

				parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
				src := []byte(sanitized)
				doc := parser.Parser().Parse(text.NewReader(src))
				foundNineItemList := false
				_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
					if !entering {
						return ast.WalkContinue, nil
					}
					if list, ok := n.(*ast.List); ok && list.ChildCount() == 9 {
						foundNineItemList = true
						return ast.WalkStop, nil
					}
					return ast.WalkContinue, nil
				})
				assert.True(t, foundNineItemList, "9-item feature list under How eve supports business agents must be preserved as a 9-item Markdown list, got:\n%s", sanitized)
			},
		},
		{
			name:    "02_docs_fontawesome_viewbox_svgs_stripped",
			fixture: "docs_fontawesome_cards.html",
			reqPath: "/docs/api-platform",
			mustContain: []string{
				"<CardGroup",
				`title="TypeScript SDK"`,
				`title="Command Line Runner"`,
			},
			mustNotContain: []string{
				"<svg",
				"TerminalIcon",
				"FolderIcon",
				"BoltBadge",
			},
			checkExtra: func(t *testing.T, res *FastPathScanResult, _ string) {
				assert.Equal(t, "API Platform Capabilities", res.Document.Title)
				assert.GreaterOrEqual(t, res.Telemetry.SvgsStripped, 3)
			},
		},
		{
			name:    "03_cjk_japanese_korean_digit_letter_no_extra_spaces",
			fixture: "cjk_flex_spans.html",
			reqPath: "/docs/i18n",
			mustContain: []string{
				"支持多模型接入与工作流编排",
				"アーキテクチャ概要とサーバー設計方針",
				"빠른시작 아키텍처가이드와핵심",
				"非布局韩文音节片段 아키텍처 不被拆裂",
				"HTTP2",
				"React19",
				"OAuth2",
				"Built for AI Agents",
			},
			mustNotContain: []string{
				"支持 多模型",
				"アーキテクチャ 概要",
				"HTTP 2",
				"React 19",
				"OAuth 2",
			},
		},
		{
			name:    "04_spacing_counter_examples_preserved",
			fixture: "spacing_counter_examples.html",
			reqPath: "/docs/spacing",
			mustContain: []string{
				"GitHub",
				"TypeScript",
				"MacOS",
				"Next.js",
				"APIs",
				"Deploy agents",
				"Quick start",
			},
			mustNotContain: []string{
				"Git Hub",
				"Type Script",
				"Mac OS",
				"Next .js",
				"API s",
			},
		},
		{
			name:    "05_span_wrapped_diagram_svg_assetized_without_script",
			fixture: "span_wrapped_diagram_svg.html",
			reqPath: "/docs/architecture",
			mustContain: []string{
				"![Ingestion Pipeline Flow](data:image/svg+xml;base64,",
				"![Standalone Neutral Span Diagram](data:image/svg+xml;base64,",
				"Pipeline Architecture",
				"Linked Card",
			},
			mustNotContain: []string{
				"<svg",
				"<script",
				"ShouldStripAnchorSVG",
			},
			checkExtra: func(t *testing.T, res *FastPathScanResult, sanitized string) {
				assert.Equal(t, 2, res.Telemetry.SvgsAssetized)
				assert.GreaterOrEqual(t, res.Telemetry.SvgsStripped, 1)
				tmpRoot := t.TempDir()
				t.Setenv("ASSETS_ROOT", tmpRoot)
				persisted := PersistSameOriginImages(context.Background(), "acme", "docs", []FirecrawlDoc{{
					Path:     res.Document.Path,
					Markdown: sanitized,
					URL:      res.Document.URL,
				}}, res.Document.URL)
				require.Len(t, persisted, 1)
				assert.Contains(t, persisted[0].Markdown, "/api/assets/acme/docs/webimg/")
				assert.NotContains(t, persisted[0].Markdown, "data:image/svg+xml;base64,")
				matches, err := filepath.Glob(filepath.Join(tmpRoot, "acme", "docs", "webimg", "*.svg"))
				require.NoError(t, err)
				require.Len(t, matches, 2)
				for _, m := range matches {
					svgBytes, err := os.ReadFile(m)
					require.NoError(t, err)
					assert.NotContains(t, string(svgBytes), "<script")
					assert.NotContains(t, string(svgBytes), "<title")
				}
			},
		},
		{
			name:    "06_n2_footer_related_cards_preserved_chrome_pruned",
			fixture: "footer_related_cards.html",
			reqPath: "/docs/getting-started",
			mustContain: []string{
				"<CardGroup",
				`href="/docs/next-guide"`,
				`href="/docs/sdk"`,
				"Next: Advanced Workflows",
				"SDK Reference",
			},
			mustNotContain: []string{
				"Edit this page",
				"Give feedback",
				"github.com/example/docs/edit",
			},
		},
		{
			name:    "07_complex_anchor_triggers_whole_group_quote_fallback",
			fixture: "weird_complex_anchor.html",
			reqPath: "/docs/plans",
			mustContain: []string{
				"> **[Pro Plan Summary →](/docs/plans/pro)**",
				"> **[Enterprise Matrix →](/docs/plans/enterprise-matrix)**",
				"Dedicated VPC",
				"99.99%",
			},
			mustNotContain: []string{
				"<CardGroup",
				"<Card",
			},
			checkExtra: func(t *testing.T, res *FastPathScanResult, _ string) {
				assert.GreaterOrEqual(t, res.Telemetry.CardGateFailures, 1)
				assert.GreaterOrEqual(t, res.Telemetry.AnchorDegradations, 2)
			},
		},
		{
			name:    "08_docusaurus_admonitions_codegroup_and_details",
			fixture: "docusaurus_admonitions_tabs.html",
			reqPath: "/docs/docusaurus",
			mustContain: []string{
				`<Callout type="warning" title="Rate Limit Notice">`,
				"<CodeGroup>",
				`<CodeGroupItem title="TypeScript">`,
				`<CodeGroupItem title="Python">`,
				`<Accordion title="How do I rotate webhook signing secrets without downtime?">`,
			},
			mustNotContain: []string{
				"<svg",
			},
		},
		{
			name:    "09_fumadocs_callout_steps_and_cards",
			fixture: "fumadocs_cards_steps.html",
			reqPath: "/docs/fumadocs",
			mustContain: []string{
				`<Callout type="info" title="Prerequisites">`,
				"<Steps>",
				`<Step title="Install Dependencies">`,
				`<Step title="Run Schema Push">`,
				"<CardGroup",
				`title="Runtime Configuration"`,
			},
		},
		{
			name:    "10_vitepress_tip_details_and_codegroup",
			fixture: "vitepress_blocks_details.html",
			reqPath: "/docs/vitepress",
			mustContain: []string{
				`<Callout type="tip" title="TIP">`,
				`<Accordion title="Inspect Default Cache Policy">`,
				"<CodeGroup>",
				"pnpm add -D vitepress",
				"npm install -D vitepress",
			},
		},
		{
			name:    "11_nextra_mixed_tabs_callout_and_aria_accordion",
			fixture: "nextra_callout_tabs.html",
			reqPath: "/docs/nextra",
			mustContain: []string{
				`<Callout type="note"`,
				"#### Overview Guide",
				"Start by registering your Nextra theme configuration",
				"#### Config Snippet",
				"docsRepositoryBase",
				`<Accordion title="Does Nextra support i18n routing?">`,
			},
		},
		{
			name:    "12_gitbook_danger_callout_steps_and_cards",
			fixture: "gitbook_hints_cards.html",
			reqPath: "/docs/gitbook",
			mustContain: []string{
				`<Callout type="danger" title="Destructive Sync Mode">`,
				"<Steps>",
				`<Step title="Connect GitHub App">`,
				`<Step title="Verify Branch Mapping">`,
				"<CardGroup",
				`href="/docs/workspaces/roles"`,
			},
		},
		{
			name:    "13_bento_custom_cards_safe_baseline",
			fixture: "bento_custom_cards.html",
			reqPath: "/docs/bento",
			mustContain: []string{
				"Event Workflows",
				"Execution Ledger",
				"Platform Beta Notice",
				`href="/docs/workflows/events"`,
				"Explore Events",
			},
			mustNotContain: []string{
				"[Explore Events](/docs/workflows/events)",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, sanitized := scanFixtureHTML(t, tt.fixture, tt.reqPath)
			assert.GreaterOrEqual(t, len(strings.TrimSpace(sanitized)), markdownMinChars)
			assert.NotContains(t, strings.ToLower(sanitized), "<svg")
			assertNoFlattenedBrokenLinks(t, tt.fixture, sanitized)

			for _, want := range tt.mustContain {
				assert.Contains(t, sanitized, want)
			}
			for _, forbid := range tt.mustNotContain {
				assert.NotContains(t, sanitized, forbid)
			}
			if tt.checkExtra != nil {
				tt.checkExtra(t, res, sanitized)
			}
		})
	}
}

func TestHeavySVGSanitizationAndPersistence(t *testing.T) {
	tests := []struct {
		name string
		svg  string
	}{
		{
			name: "multi_path_heavy_diagram_svg_stripped_scripts_and_titles_zero_raw_svg",
			svg: func() string {
				var b strings.Builder
				b.WriteString(`<figure><svg width="720" height="360" viewBox="0 0 720 360" onload="alert(1)">`)
				b.WriteString(`<title>Heavy Architecture Flow</title><script>evil()</script>`)
				for i := 0; i < 36; i++ {
					b.WriteString(`<rect x="10" y="10" width="20" height="20"/>`)
				}
				b.WriteString(`</svg><figcaption>Complex topology graph</figcaption></figure>`)
				return b.String()
			}(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			htmlStr := "<!DOCTYPE html><html><body><main><h1>Heavy Diagram</h1><p>Inspecting deterministic SVG safety, script removal, attribute stripping, and base64-to-disk assetization under high node density for real production architecture diagrams ingested through the crawler pipeline.</p>" +
				tt.svg + "<p>Trailing verification narrative confirming zero leaked inline script vectors remain inside rendered documentation artifacts.</p></main></body></html>"
			md, _, _, tel, ok := ConvertHTMLToMarkdown(htmlStr, "https://example.com/docs/heavy")
			require.True(t, ok)
			assert.Equal(t, 1, tel.SvgsAssetized)
			assert.NotContains(t, strings.ToLower(md), "<svg")
			assert.Contains(t, md, "data:image/svg+xml;base64,")

			tmpRoot := t.TempDir()
			t.Setenv("ASSETS_ROOT", tmpRoot)
			persisted := PersistSameOriginImages(context.Background(), "acme", "docs", []FirecrawlDoc{{
				Path:     "docs/heavy.md",
				Markdown: md,
				URL:      "https://example.com/docs/heavy",
			}}, "https://example.com/docs/heavy")
			require.Len(t, persisted, 1)
			assert.Contains(t, persisted[0].Markdown, "/api/assets/acme/docs/webimg/")
			assert.NotContains(t, persisted[0].Markdown, "data:image/svg+xml")

			files, err := filepath.Glob(filepath.Join(tmpRoot, "acme", "docs", "webimg", "*.svg"))
			require.NoError(t, err)
			require.Len(t, files, 1)
			rawSaved, err := os.ReadFile(files[0])
			require.NoError(t, err)
			assert.False(t, bytes.Contains(rawSaved, []byte("<script")))
			assert.False(t, bytes.Contains(rawSaved, []byte("onload")))
			assert.True(t, bytes.Contains(rawSaved, []byte(`xmlns="http://www.w3.org/2000/svg"`)))
			_ = extast.KindTable
		})
	}
}

func TestContentLiftAdversarialEdgeCases(t *testing.T) {
	longBody := "Detailed architectural documentation explaining deterministic DOM lifting boundaries, typography preservation, and fail-closed safety constraints across heterogeneous web doc engines so main/body extraction thresholds pass reliably."
	tests := []struct {
		name           string
		htmlBody       string
		mustContain    []string
		mustNotContain []string
	}{
		{
			name: "mixed_prose_and_code_inside_tabpanel_not_dropped",
			htmlBody: `<main><h1>CLI Setup</h1><p>` + longBody + `</p>` +
				`<div class="code-tabs"><div role="tablist"><button role="tab" aria-selected="true">npm</button><button role="tab">pnpm</button></div>` +
				`<div role="tabpanel"><p>Install first:</p><pre><code class="language-bash">npm install @acme/cli</code></pre></div>` +
				`<div role="tabpanel"><p>Install with pnpm:</p><pre><code class="language-bash">pnpm add @acme/cli</code></pre></div></div></main>`,
			mustContain:    []string{"#### npm", "Install first:", "npm install @acme/cli", "#### pnpm", "Install with pnpm:", "pnpm add @acme/cli"},
			mustNotContain: []string{"<button", "<CodeGroup"},
		},
		{
			name: "pure_code_tab_with_short_filename_header_lifted_to_codegroup",
			htmlBody: `<main><h1>SDK Install</h1><p>` + longBody + `</p>` +
				`<div class="code-tabs"><div role="tablist"><button role="tab" aria-selected="true">TypeScript</button><button role="tab">Shell</button></div>` +
				`<div role="tabpanel"><span class="code-title">index.ts</span><pre><code class="language-ts">export const ok = true;</code></pre></div>` +
				`<div role="tabpanel"><span class="code-title">install.sh</span><pre><code class="language-bash">npm i @acme/sdk</code></pre></div></div></main>`,
			mustContain:    []string{"<CodeGroup>", `<CodeGroupItem title="TypeScript">`, "export const ok = true;", `<CodeGroupItem title="Shell">`, "npm i @acme/sdk"},
			mustNotContain: []string{"<button"},
		},
		{
			name: "pre_br_preserves_newlines_in_codegroup",
			htmlBody: `<main><h1>Multiline Code</h1><p>` + longBody + `</p>` +
				`<div role="tablist"><button role="tab" aria-selected="true">Shell</button></div>` +
				`<div role="tabpanel"><pre><code class="language-bash">echo first<br/>echo second<br>echo third</code></pre></div></main>`,
			mustContain: []string{"<CodeGroup>", "echo first\necho second\necho third"},
		},
		{
			name: "details_accordion_lifts_nested_cardgroup_instead_of_flattening",
			htmlBody: `<main><h1>Nested Cards</h1><p>` + longBody + `</p>` +
				`<details><summary>Integrations</summary>` +
				`<div class="grid"><a href="/docs/a"><div><h4>Alpha</h4><p>Connect Alpha workflow runner.</p></div></a>` +
				`<a href="/docs/b"><div><h4>Beta</h4><p>Connect Beta telemetry sink.</p></div></a></div>` +
				`</details></main>`,
			mustContain: []string{`<Accordion title="Integrations">`, `<CardGroup cols="2">`, `<Card title="Alpha" href="/docs/a">`, `<Card title="Beta" href="/docs/b">`},
		},
		{
			name: "block_and_inline_spacing_avoids_word_gluing",
			htmlBody: `<main><h1>Spacing Check</h1><p>` + longBody + `</p>` +
				`<div><span>For your team</span><h3>Triage</h3></div></main>`,
			mustContain:    []string{"For your team"},
			mustNotContain: []string{"teamTriage"},
		},
		{
			name: "failed_aria_controls_in_heading_preserves_heading_text_without_button",
			htmlBody: `<main><h1>Accordion Failure Safety</h1><p>` + longBody + `</p>` +
				`<div><h3><button type="button" aria-expanded="false" aria-controls="shared-panel">Workflow Triggers</button></h3>` +
				`<h3><button type="button" aria-expanded="false" aria-controls="shared-panel">Webhook Actions</button></h3>` +
				`<div id="shared-panel"><p>Shared panel content cannot belong exclusively to either button.</p></div></div></main>`,
			mustContain:    []string{"Workflow Triggers", "Webhook Actions", "Shared panel content cannot belong exclusively to either button."},
			mustNotContain: []string{"<Accordion", "<button"},
		},
		{
			name: "bare_aside_on_body_fallback_not_lifted_as_callout",
			htmlBody: `<body><div class="doc-wrap"><h1>Body Fallback</h1><p>` + longBody + `</p>` +
				`<aside><p>Sidebar navigation note with plain links.</p><ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li><li><a href="/c">Three</a></li></ul></aside>` +
				`<p>Extra article conclusion ensuring full document length meets scanner body extraction requirements cleanly.</p></div></body>`,
			mustContain:    []string{"Extra article conclusion"},
			mustNotContain: []string{"<Callout"},
		},
		{
			name: "degraded_block_anchor_prefers_heading_over_eyebrow",
			htmlBody: `<main><h1>Degraded Quote Card</h1><p>` + longBody + `</p>` +
				`<a href="/docs/deep-dive">` +
				`<span class="eyebrow">NEW</span>` +
				`<h3>Primary Card Heading</h3>` +
				`<div><table><tr><th>Key</th><th>Value</th></tr><tr><td>Mode</td><td>Strict</td></tr></table></div>` +
				`</a></main>`,
			mustContain:    []string{`> **[Primary Card Heading`},
			mustNotContain: []string{`> **[NEW`},
		},
		{
			name: "card_eyebrow_font_medium_does_not_hijack_text_heading_title",
			htmlBody: `<main><h1>Eyebrow Card</h1><p>` + longBody + `</p>` +
				`<div class="grid grid-cols-2 gap-4">` +
				`<a href="#one"><div class="flex flex-col gap-1"><span class="text-label-14 font-medium">For your team</span><span class="text-heading-20 font-semibold">Business agents</span><div><p>Team workflows.</p></div></div></a>` +
				`<a href="#two"><div class="flex flex-col gap-1"><span class="text-label-14 font-medium">For ops</span><span class="text-heading-20 font-semibold">Engineering agents</span><div><p>Ops workflows.</p></div></div></a>` +
				`</div></main>`,
			mustContain:    []string{`<Card title="Business agents" eyebrow="For your team" href="#one">`, `<Card title="Engineering agents" eyebrow="For ops" href="#two">`},
			mustNotContain: []string{`title="For your team"`, `title="For ops"`},
		},
		{
			name: "border_y_short_feature_list_with_block_spans_not_collapsed_or_glued",
			htmlBody: `<main><h1>Feature List</h1><p>` + longBody + `</p>` +
				`<h3>How eve supports business agents</h3>` +
				`<ul class="not-prose my-6 min-w-0 list-none border-gray-alpha-400 border-y p-0">` +
				`<li><span class="block font-medium">Channel sync</span><span class="block">Use <a href="/docs/channels">Channels</a> everywhere</span></li>` +
				`<li><span class="block font-medium">Short item</span><span class="block">Fast setup</span></li>` +
				`<li><span class="block font-medium">Audit logs</span><span class="block">Trace runs</span></li>` +
				`</ul></main>`,
			mustContain:    []string{"- Channel sync Use [Channels](/docs/channels) everywhere", "- Short item Fast setup", "- Audit logs Trace runs"},
			mustNotContain: []string{"<CardGroup", "`Short item", "Channel syncUse", "Short itemFast", "Audit logsTrace"},
		},
		{
			name: "geist_text_gray_1000_text_heading_not_hijacked_by_longer_eyebrow_or_bold_badge",
			htmlBody: `<main><h1>Geist Heading Precedence</h1><p>` + longBody + `</p>` +
				`<div class="grid gap-4 sm:grid-cols-2">` +
				`<a href="#ops"><div class="flex flex-col gap-1"><span class="text-copy-13 text-gray-900">For your engineering team</span><span class="flex items-center text-gray-1000 text-heading-20">Ops bots</span><div class="text-copy-14 text-gray-900"><p>Automate on-call triage workflows.</p></div></div></a>` +
				`<a href="#sec"><div class="flex flex-col gap-1"><span class="text-copy-13 text-gray-900">For your security teams</span><span class="flex items-center text-gray-1000 text-heading-20">Sec bots</span><div class="text-copy-14 text-gray-900"><p>Automate audit log reviews.</p></div></div></a>` +
				`</div>` +
				`<div class="grid gap-4 sm:grid-cols-2">` +
				`<a href="https://github.com/vercel/a"><span class="text-gray-1000 text-heading-16">Router</span><span class="font-semibold">Beta</span><div><p>Route incoming requests.</p></div></a>` +
				`<a href="https://github.com/vercel/b"><span class="text-gray-1000 text-heading-16">Worker</span><span class="font-semibold">Stable</span><div><p>Execute background jobs.</p></div></a>` +
				`</div></main>`,
			mustContain:    []string{`<Card title="Ops bots" eyebrow="For your engineering team" href="#ops">`, `<Card title="Sec bots" eyebrow="For your security teams" href="#sec">`, `<Card title="Router" href="https://github.com/vercel/a">`, `<Card title="Worker" href="https://github.com/vercel/b">`},
			mustNotContain: []string{`title="For your engineering team"`, `title="For your security teams"`, `title="Beta"`, `title="Stable"`},
		},
		{
			name: "vertical_flex_col_and_space_y_lists_never_collapsed_or_turned_into_cards",
			htmlBody: `<main><h1>Vertical List Safety</h1><p>` + longBody + `</p>` +
				`<ul class="space-y-2"><li>Install</li><li>Build</li><li>Deploy</li></ul>` +
				`<ol class="space-y-2"><li>First</li><li>Second</li></ol>` +
				`<ul class="flex flex-col gap-4">` +
				`<li><div class="flex flex-col gap-1"><span class="text-heading-16">Feature A</span><p>Route requests via <a href="/docs/channels">Channels</a> cleanly.</p></div></li>` +
				`<li><div class="flex flex-col gap-1"><span class="text-heading-16">Feature B</span><p>Audit tool runs via <a href="/docs/evals">Evals</a> reliably.</p></div></li>` +
				`</ul></main>`,
			mustContain:    []string{"- Install\n- Build\n- Deploy", "1. First\n2. Second", "[Channels](/docs/channels)", "[Evals](/docs/evals)"},
			mustNotContain: []string{"`Install`", "`First`", "<CardGroup", "<Card"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			md, _, _, _, ok := ConvertHTMLToMarkdown("<!DOCTYPE html><html><body>"+tt.htmlBody+"</body></html>", "https://example.com/docs/edge")
			require.True(t, ok)
			sanitized := SanitizeMarkdown("docs/edge.md", md)
			for _, want := range tt.mustContain {
				assert.Contains(t, sanitized, want)
			}
			for _, forbid := range tt.mustNotContain {
				assert.NotContains(t, sanitized, forbid)
			}
		})
	}
}
