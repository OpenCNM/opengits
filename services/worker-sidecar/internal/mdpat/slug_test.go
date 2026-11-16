package mdpat_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func TestSlugify(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
		isHash   bool
	}{
		{
			name:     "empty string returns empty",
			input:    "",
			expected: "",
		},
		{
			name:     "whitespace string returns empty",
			input:    "   \t\n  ",
			expected: "",
		},
		{
			name:     "standard ascii slug",
			input:    "Hello World!",
			expected: "hello-world",
		},
		{
			name:     "chinese characters preserved",
			input:    "## 01_介绍与架构 {#intro-section}",
			expected: "01_介绍与架构-intro-section",
		},
		{
			name:     "pure chinese title",
			input:    "快速开始",
			expected: "快速开始",
		},
		{
			name:     "japanese hiragana and katakana",
			input:    "はじめに & アーキテクチャ",
			expected: "はじめに-アーキテクチャ",
		},
		{
			name:     "korean hangul",
			input:    "시작하기 및 핵심 개념",
			expected: "시작하기-및-핵심-개념",
		},
		{
			name:     "mixed ascii cjk numbers",
			input:    "1.2.3. Event Loop 事件循环",
			expected: "1-2-3-event-loop-事件循环",
		},
		{
			name:     "consecutive dashes and special symbols collapsed",
			input:    "foo -- bar ::: baz",
			expected: "foo-bar-baz",
		},
		{
			name:   "pure punctuation falls back to deterministic fnv hash",
			input:  "???",
			isHash: true,
		},
		{
			name:   "pure symbols fall back to deterministic fnv hash",
			input:  "--- ::: @@@",
			isHash: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := mdpat.Slugify(tt.input)
			if tt.isHash {
				expectedHash := "h-" + mdpat.Fnv64aHex(strings.TrimSpace(tt.input))
				assert.Equal(t, expectedHash, actual)
				assert.NotEmpty(t, actual)
			} else {
				assert.Equal(t, tt.expected, actual)
			}
		})
	}
}

func TestSlugifyUnderscore(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
		isHash   bool
	}{
		{
			name:     "empty input returns empty",
			input:    "",
			expected: "",
		},
		{
			name:     "ascii hyphen to underscore",
			input:    "user-center-service",
			expected: "user_center_service",
		},
		{
			name:     "chinese module name preserved",
			input:    "用户中心",
			expected: "用户中心",
		},
		{
			name:     "japanese module name preserved",
			input:    "認証サブシステム",
			expected: "認証サブシステム",
		},
		{
			name:     "korean module name preserved",
			input:    "결제_시스템",
			expected: "결제_시스템",
		},
		{
			name:   "pure punctuation falls back to id_<hash>",
			input:  "??!?!?",
			isHash: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := mdpat.SlugifyUnderscore(tt.input)
			if tt.isHash {
				expectedHash := "id_" + mdpat.Fnv64aHex(strings.TrimSpace(tt.input))
				assert.Equal(t, expectedHash, actual)
			} else {
				assert.Equal(t, tt.expected, actual)
			}
		})
	}
}

func TestIsCJKRune(t *testing.T) {
	tests := []struct {
		r        rune
		expected bool
	}{
		{'中', true},
		{'文', true},
		{'あ', true}, // Hiragana
		{'ア', true}, // Katakana
		{'ー', true}, // Japanese prolonged sound mark U+30FC
		{'々', true}, // Ideographic iteration mark U+3005
		{'한', true}, // Hangul
		{'글', true}, // Hangul
		{'a', false},
		{'Z', false},
		{'0', false},
		{'_', false},
		{'-', false},
		{' ', false},
		{'🚀', false},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("rune_%c", tt.r), func(t *testing.T) {
			assert.Equal(t, tt.expected, mdpat.IsCJKRune(tt.r))
		})
	}
}

func TestFnv64aDeterminism(t *testing.T) {
	h1 := mdpat.Fnv64a("test-input")
	h2 := mdpat.Fnv64a("test-input")
	assert.Equal(t, h1, h2)
	assert.NotZero(t, h1)

	hex1 := mdpat.Fnv64aHex("test-input")
	hex2 := mdpat.Fnv64aHex("test-input")
	assert.Equal(t, hex1, hex2)
	assert.NotEmpty(t, hex1)

	assert.NotEqual(t, mdpat.Fnv64a("input-1"), mdpat.Fnv64a("input-2"))
}

func TestSplitPathAnchor(t *testing.T) {
	tests := []struct {
		name           string
		raw            string
		expectedPath   string
		expectedAnchor string
	}{
		{
			name:           "standard path with anchor",
			raw:            "src/index.ts#mitt",
			expectedPath:   "src/index.ts",
			expectedAnchor: "mitt",
		},
		{
			name:           "relative path with leading dot slash and spaces",
			raw:            "  ./src/core/emitter.ts#on  ",
			expectedPath:   "src/core/emitter.ts",
			expectedAnchor: "on",
		},
		{
			name:           "windows backslash path with anchor",
			raw:            "src\\index.ts#emit",
			expectedPath:   "src/index.ts",
			expectedAnchor: "emit",
		},
		{
			name:           "plain path without anchor",
			raw:            "README.md",
			expectedPath:   "README.md",
			expectedAnchor: "",
		},
		{
			name:           "path with empty anchor suffix",
			raw:            "/src/index.ts#",
			expectedPath:   "src/index.ts",
			expectedAnchor: "",
		},
		{
			name:           "markdown heading anchor with spaces",
			raw:            "README.md#Quick Start Guide",
			expectedPath:   "README.md",
			expectedAnchor: "Quick Start Guide",
		},
		{
			name:           "empty string returns empty",
			raw:            "",
			expectedPath:   "",
			expectedAnchor: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, a := mdpat.SplitPathAnchor(tt.raw)
			assert.Equal(t, tt.expectedPath, p)
			assert.Equal(t, tt.expectedAnchor, a)
		})
	}
}

func TestJoinPathAnchor(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		anchor   string
		expected string
	}{
		{
			name:     "clean path and anchor",
			path:     "src/index.ts",
			anchor:   "on",
			expected: "src/index.ts#on",
		},
		{
			name:     "path already has anchor and empty raw anchor preserves existing",
			path:     "src/index.ts#on",
			anchor:   "",
			expected: "src/index.ts#on",
		},
		{
			name:     "path already has anchor and raw anchor overrides",
			path:     "src/index.ts#old",
			anchor:   "new",
			expected: "src/index.ts#new",
		},
		{
			name:     "empty anchor returns clean path",
			path:     "./src/index.ts",
			anchor:   "",
			expected: "src/index.ts",
		},
		{
			name:     "empty path returns hash anchor",
			path:     "",
			anchor:   "section",
			expected: "#section",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, mdpat.JoinPathAnchor(tt.path, tt.anchor))
		})
	}
}
