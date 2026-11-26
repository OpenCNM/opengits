package pipeline

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBalanceCodeFences(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "already balanced fences",
			input:    "# Title\n\n```go\nfunc main() {}\n```\n\nEnding.",
			expected: "# Title\n\n```go\nfunc main() {}\n```\n\nEnding.",
		},
		{
			name:     "unclosed backtick fence",
			input:    "# Title\n\n```go\nfunc main() {\n  println(1)",
			expected: "# Title\n\n```go\nfunc main() {\n  println(1)\n```\n",
		},
		{
			name:     "unclosed tilde fence with 4 tildes",
			input:    "# Title\n\n~~~~json\n{\"key\": 1}",
			expected: "# Title\n\n~~~~json\n{\"key\": 1}\n~~~~\n",
		},
		{
			name:     "empty content",
			input:    "",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BalanceCodeFences(tt.input)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestTryAutoCloseTags(t *testing.T) {
	mockValidator := func(content string) (bool, string) {
		if strings.Contains(content, "<Callout>") && !strings.Contains(content, "</Callout>") {
			return false, "Expected a closing tag for `<Callout>` in MDX"
		}
		if strings.Contains(content, "<Steps>") && !strings.Contains(content, "</Steps>") {
			return false, "Expected a closing tag for `<Steps>` in MDX"
		}
		return true, ""
	}

	input := "# Intro\n\n<Callout>\nImportant notice here without closing."
	errMsg := "Expected a closing tag for `<Callout>` in MDX"

	healed, ok := TryAutoCloseTags(input, errMsg, mockValidator)
	require.True(t, ok)
	assert.Contains(t, healed, "</Callout>")

	unknownErr := "Expected a closing tag for `<UnknownComponent>` in MDX"
	_, notOk := TryAutoCloseTags(input, unknownErr, mockValidator)
	assert.False(t, notOk)
}

func TestExtractErrorLine(t *testing.T) {
	content := `# Title
Line 2
Line 3
<Callout type="info">
Content inside callout
Line 6
Line 7 with <T> generic
Line 8
<Component prop={invalid + 123} />
Line 10`

	t.Run("explicit line in error message", func(t *testing.T) {
		assert.Equal(t, 25, ExtractErrorLine("compile error at line 25: syntax error", content))
		assert.Equal(t, 42, ExtractErrorLine("SyntaxError: Unexpected token (42:15)", content))
	})

	t.Run("unclosed tag line detection", func(t *testing.T) {
		assert.Equal(t, 4, ExtractErrorLine("Expected a closing tag for `<Callout>` in MDX", content))
	})

	t.Run("generic type collision line detection", func(t *testing.T) {
		assert.Equal(t, 7, ExtractErrorLine("Contains generic type parameter collision outside code block (e.g. <T>)", content))
	})

	t.Run("jsx attribute error line detection", func(t *testing.T) {
		assert.Equal(t, 9, ExtractErrorLine("Unexpected character in JSX attribute expression: {invalid + 123}", content))
	})

	t.Run("unresolvable error returns 0", func(t *testing.T) {
		assert.Equal(t, 0, ExtractErrorLine("generic vague failure without lines", content))
	})
}
