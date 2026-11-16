package pipeline

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStripPayloadShell(t *testing.T) {
	tests := []struct {
		name        string
		raw         string
		wantContent string
		wantShell   string
	}{
		{
			name:        "plain markdown without shell",
			raw:         "# Intro\n\nThis is normal markdown.",
			wantContent: "# Intro\n\nThis is normal markdown.",
			wantShell:   "",
		},
		{
			name:        "sentinel wrapped content",
			raw:         "===CONTENT_BEGIN===\n# Architecture\n\nDetails here.\n===CONTENT_END===",
			wantContent: "# Architecture\n\nDetails here.",
			wantShell:   "sentinel",
		},
		{
			name:        "outer markdown fence wrapped content",
			raw:         "```markdown\n# Lesson 1\n\nWelcome to course.\n```",
			wantContent: "# Lesson 1\n\nWelcome to course.",
			wantShell:   "fence:markdown",
		},
		{
			name:        "outer mdx fence wrapped content",
			raw:         "~~~mdx\n# Lesson 2\n\nWelcome to course.\n~~~",
			wantContent: "# Lesson 2\n\nWelcome to course.",
			wantShell:   "fence:mdx",
		},
		{
			name: "json wrapper with lessonMarkdown",
			raw:  `{"lessonMarkdown": "# Lesson Title\n\nParagraph 1.\n\nParagraph 2."}`,
			wantContent: "# Lesson Title\n\nParagraph 1.\n\nParagraph 2.",
			wantShell:   "json:lessonMarkdown",
		},
		{
			name: "json wrapper with markdown key",
			raw:  `{"markdown": "# Chapter\n\nSome text with \"quotes\"."}`,
			wantContent: "# Chapter\n\nSome text with \"quotes\".",
			wantShell:   "json:markdown",
		},
		{
			name: "json wrapper with content key and escaped newlines",
			raw:  `{"content": "# Heading\n\nLine 1\nLine 2"}`,
			wantContent: "# Heading\n\nLine 1\nLine 2",
			wantShell:   "json:content",
		},
		{
			name: "json wrapper wrapped inside json fence",
			raw: "```json\n" +
				`{"lessonMarkdown": "# Hello from JSON Fence"}` + "\n" +
				"```",
			wantContent: "# Hello from JSON Fence",
			wantShell:   "fence:json+json:lessonMarkdown",
		},
		{
			name: "json wrapper containing sentinels",
			raw: `{"lessonMarkdown": "===CONTENT_BEGIN===\n# Hello With Sentinel\n===CONTENT_END==="}`,
			wantContent: "# Hello With Sentinel",
			wantShell:   "json:lessonMarkdown+sentinel",
		},
		{
			name: "markdown content containing inner code fence should retain inner fence",
			raw: "# Heading\n\nHere is some code:\n```go\nfunc main() {\n\tprintln(\"ok\")\n}\n```\nEnd of section.",
			wantContent: "# Heading\n\nHere is some code:\n```go\nfunc main() {\n\tprintln(\"ok\")\n}\n```\nEnd of section.",
			wantShell:   "",
		},
		{
			name: "nested json wrapper inside data container",
			raw:  `{"status": "ok", "data": {"markdown": "# Nested Data Heading\n\nContent here."}}`,
			wantContent: "# Nested Data Heading\n\nContent here.",
			wantShell:   "json:data.markdown",
		},
		{
			name: "openai choices format json",
			raw:  `{"choices": [{"message": {"role": "assistant", "content": "# From Choices\n\nValid lesson."}}]}`,
			wantContent: "# From Choices\n\nValid lesson.",
			wantShell:   "json:choices.0.message.content",
		},
		{
			name: "conversational prefix and suffix around json",
			raw:  "Here is the requested lesson in JSON format:\n" + `{"lessonMarkdown": "# Lesson With Chat\n\nBody text."}` + "\nI hope this helps!",
			wantContent: "# Lesson With Chat\n\nBody text.",
			wantShell:   "json:lessonMarkdown",
		},
		{
			name: "thinking tags with code fences",
			raw:  "<think>\nLet's plan the markdown lesson.\n</think>\n```markdown\n# Planned Lesson\n\nContent here.\n```",
			wantContent: "# Planned Lesson\n\nContent here.",
			wantShell:   "think+fence:markdown",
		},
		{
			name: "json wrapper with trailing escaped quote defect (glm-5.3-flash pattern)",
			raw:  "{\n  \"lessonMarkdown\": \"# Lesson Title\\n\\nClosing sentence.\\\"\\n}",
			wantContent: "# Lesson Title\n\nClosing sentence.",
			wantShell:   "json:lessonMarkdown",
		},
		{
			name: "json wrapper with trailing escaped quote directly before brace",
			raw:  "{\"markdown\": \"# Direct Defect\\\"}",
			wantContent: "# Direct Defect",
			wantShell:   "json:markdown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotContent, gotShell := StripPayloadShell(tt.raw)
			require.Equal(t, tt.wantContent, gotContent)
			assert.Equal(t, tt.wantShell, gotShell)
		})
	}
}

func TestHasUnpeeledJSONShell(t *testing.T) {
	assert.True(t, HasUnpeeledJSONShell(`{"lessonMarkdown": "content"}`))
	assert.True(t, HasUnpeeledJSONShell(`{ "markdown": "# Title" }`))
	assert.True(t, HasUnpeeledJSONShell(`{"choices": []}`))
	assert.True(t, HasUnpeeledJSONShell("{\n  \"content\": \"text\"\n}"))

	assert.False(t, HasUnpeeledJSONShell("# Normal Markdown"))
	assert.False(t, HasUnpeeledJSONShell("---\nsummary: hello\n---\n## Body"))
	assert.False(t, HasUnpeeledJSONShell("{/* JSX comment */}\n# Title"))
	assert.False(t, HasUnpeeledJSONShell(""))
}

func TestDeescapeJSONStringContent(t *testing.T) {
	tests := []struct {
		name        string
		raw         string
		key         string
		wantContent string
		wantOk      bool
	}{
		{
			name:        "standard escaped string",
			raw:         `{"lessonMarkdown": "Line 1\nLine 2\tTabbed"}`,
			key:         "lessonMarkdown",
			wantContent: "Line 1\nLine 2\tTabbed",
			wantOk:      true,
		},
		{
			name:        "raw unescaped newlines in JSON string (standard json fails)",
			raw:         "{\n  \"lessonMarkdown\": \"# Title\nLine with raw newline\nAnother line\"\n}",
			key:         "lessonMarkdown",
			wantContent: "# Title\nLine with raw newline\nAnother line",
			wantOk:      true,
		},
		{
			name:        "LaTeX non-standard escape preservation",
			raw:         `{"markdown": "Formula: \alpha + \beta = \gamma"}`,
			key:         "markdown",
			wantContent: `Formula: \alpha + \beta = \gamma`,
			wantOk:      true,
		},
		{
			name:        "unicode escape conversion",
			raw:         `{"content": "Unicode: \u4e2d\u6587"}`,
			key:         "content",
			wantContent: "Unicode: 中文",
			wantOk:      true,
		},
		{
			name:        "trailing escaped quote directly before closing brace (glm-5.3-flash)",
			raw:         "{\n  \"lessonMarkdown\": \"# Lesson\\nClosing line.\\\"\\n}",
			key:         "lessonMarkdown",
			wantContent: "# Lesson\nClosing line.",
			wantOk:      true,
		},
		{
			name:        "unescaped quotes in prose text",
			raw:         `{"lessonMarkdown": "He said "hello" to the world."}`,
			key:         "lessonMarkdown",
			wantContent: `He said "hello" to the world.`,
			wantOk:      true,
		},
		{
			name:        "truncated JSON cut off by token limit without closing quote",
			raw:         "{\n  \"lessonMarkdown\": \"# Incomplete Chapter\n\nParagraph text that was cut off at the end",
			key:         "lessonMarkdown",
			wantContent: "# Incomplete Chapter\n\nParagraph text that was cut off at the end",
			wantOk:      true,
		},
		{
			name:        "nested key in object",
			raw:         `{"data": {"body": "# Nested Body Text"}}`,
			key:         "body",
			wantContent: "# Nested Body Text",
			wantOk:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := DeescapeJSONStringContent(tt.raw, tt.key)
			require.Equal(t, tt.wantOk, ok)
			assert.Equal(t, tt.wantContent, got)
		})
	}
}

