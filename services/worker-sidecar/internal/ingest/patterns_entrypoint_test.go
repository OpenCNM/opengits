package ingest

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsEntryPointBasenamePrefix(t *testing.T) {
	p := DefaultPatterns()

	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "exact entry file", path: "src/app.js", want: true},
		{name: "basename prefix app.", path: "src/app.module.ts", want: true},
		{name: "basename prefix index.", path: "packages/lib/index.ts", want: true},
		{name: "homepage.md is NOT an entry", path: "docs/homepage.md", want: false},
		{name: "myapp.ts is NOT an entry", path: "web/myapp.ts", want: false},
		{name: "remain.txt is NOT an entry", path: "notes/remain.txt", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, p.IsEntryPoint(tt.path))
		})
	}
}
