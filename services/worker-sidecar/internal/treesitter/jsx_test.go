package treesitter

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractJsxRanges(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	tests := []struct {
		name         string
		source       string
		expectedTags []string
	}{
		{
			name: "self-closing tag with numeric attribute",
			source: `
const x = 1;
<Badge count={5} />
const y = 2;
`,
			expectedTags: []string{`<Badge count={5} />`},
		},
		{
			name: "nested component with style object and children",
			source: `
<Card style={{ color: "red", margin: 10 }}>
  <Title level={2}>Hello World</Title>
</Card>
`,
			expectedTags: []string{
				`<Card style={{ color: "red", margin: 10 }}>
  <Title level={2}>Hello World</Title>
</Card>`,
			},
		},
		{
			name: "multiple separate JSX tags",
			source: `
<Badge count={1} />
const a = 10;
<Alert type="warning" message={err.message} />
`,
			expectedTags: []string{
				`<Badge count={1} />`,
				`<Alert type="warning" message={err.message} />`,
			},
		},
		{
			name: "generic in code vs JSX",
			source: `
function test<T>() {
  return <Component value={val} />;
}
`,
			expectedTags: []string{`<Component value={val} />`},
		},
		{
			name: "mixed Markdown with headings, lists and JSX",
			source: `# Section 1

Here is some text with {plain_brace}.

<Badge count={5} />

- List item 1
- List item 2

<Card style={{ color: "blue" }}>
  Content with {more_braces}
</Card>
`,
			expectedTags: []string{
				`<Badge count={5} />`,
				`<Card style={{ color: "blue" }}>`,
				`</Card>`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ranges, err := engine.ScanMdxJsxRanges(ctx, []byte(tt.source))
			require.NoError(t, err)

			var extracted []string
			for _, r := range ranges {
				extracted = append(extracted, string(tt.source[r.Start:r.End]))
			}
			assert.Equal(t, tt.expectedTags, extracted)
		})
	}
}

func TestMergeByteRanges(t *testing.T) {
	ranges := []ByteRange{
		{Start: 10, End: 20},
		{Start: 15, End: 25},
		{Start: 30, End: 40},
		{Start: 5, End: 8},
		{Start: 35, End: 50},
	}

	merged := MergeByteRanges(ranges)
	expected := []ByteRange{
		{Start: 5, End: 8},
		{Start: 10, End: 25},
		{Start: 30, End: 50},
	}
	assert.Equal(t, expected, merged)
}
