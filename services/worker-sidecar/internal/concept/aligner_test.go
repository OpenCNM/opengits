package concept

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseScopedConcept_TableDriven(t *testing.T) {
	tests := []struct {
		name            string
		raw             string
		wantScope       string
		wantConceptName string
	}{
		{
			name:            "standard owner and repo with concept",
			raw:             "facebook/react#Hooks",
			wantScope:       "facebook/react",
			wantConceptName: "Hooks",
		},
		{
			name:            "simple repo with concept",
			raw:             "next.js#Routing",
			wantScope:       "next.js",
			wantConceptName: "Routing",
		},
		{
			name:            "plain concept without scope",
			raw:             "VirtualDOM",
			wantScope:       "",
			wantConceptName: "VirtualDOM",
		},
		{
			name:            "whitespace trimming across scope and concept",
			raw:             "  vercel/next.js # App Router  ",
			wantScope:       "vercel/next.js",
			wantConceptName: "App Router",
		},
		{
			name:            "multiple hashes splits on last index",
			raw:             "org/repo#module#subconcept",
			wantScope:       "org/repo#module",
			wantConceptName: "subconcept",
		},
		{
			name:            "empty string returns empty",
			raw:             "   ",
			wantScope:       "",
			wantConceptName: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scope, conceptName := ParseScopedConcept(tt.raw)
			assert.Equal(t, tt.wantScope, scope)
			assert.Equal(t, tt.wantConceptName, conceptName)
		})
	}
}
