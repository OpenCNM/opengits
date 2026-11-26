package mdx

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHealSourceJsxProtection(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "JSX self-closing tag with numeric attribute expression",
			input:    "# Header\n\n<Badge count={5} />\n\nSome text with {variable}.",
			expected: "# Header\n\n<Badge count={5} />\n\nSome text with &#123;variable&#125;.",
		},
		{
			name:     "JSX component with nested style object",
			input:    "# Card\n\n<Card style={{ color: 'red', margin: 10 }}>\n  Text with {brace}\n</Card>",
			expected: "# Card\n\n<Card style={{ color: 'red', margin: 10 }}>\n  Text with &#123;brace&#125;\n</Card>",
		},
		{
			name:     "Multiple JSX components with code blocks and prose",
			input:    "# Docs\n\n```json\n{ \"raw\": true }\n```\n\n<Callout type=\"info\" icon={icons.info}>\n  Notice {item}\n</Callout>\n\nProse with {unclosed.",
			expected: "# Docs\n\n```json\n{ \"raw\": true }\n```\n\n<Callout type=\"info\" icon={icons.info}>\n  Notice &#123;item&#125;\n</Callout>\n\nProse with &#123;unclosed.",
		},
		{
			name:     "Generic parameter <T> in prose is not JSX and has braces escaped",
			input:    "Container<T> has {key: value}",
			expected: "Container<T> has &#123;key: value&#125;",
		},
		{
			name:     "Void HTML tags in table prose normalized to self-closing",
			input:    "| Col 1 | Col 2 |\n|---|---|\n| val | line1<br>line2<hr><img src=\"test.png\"> |",
			expected: "| Col 1 | Col 2 |\n|---|---|\n| val | line1<br />line2<hr /><img src=\"test.png\" /> |",
		},
		{
			name:     "Void HTML tags inside code blocks strictly preserved",
			input:    "```html\n<br>\n<hr>\n```\n\n`<br>` in inline code",
			expected: "```html\n<br>\n<hr>\n```\n\n`<br>` in inline code",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := HealSource(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestHealSourceGoldenParity(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/mdx-healer.golden.json")
	require.NoError(t, err, "mdx-healer.golden.json missing")

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
			got, err := HealSource(tc.Input)
			require.NoError(t, err)
			assert.Equal(t, tc.Expected, got, "golden case %s mismatch", tc.Name)
		})
	}
}
