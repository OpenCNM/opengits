package treesitter

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractControlFlow(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	t.Run("Go function with if branch and return", func(t *testing.T) {
		code := `package main

func ProcessUser(id string) (*User, error) {
	if id == "" {
		return nil, ErrEmptyID
	}
	return &User{ID: id}, nil
}
`
		nodes, err := engine.ExtractControlFlow(ctx, "go", []byte(code))
		require.NoError(t, err)
		assert.NotEmpty(t, nodes)

		var hasFunc, hasBranch, hasReturn bool
		for _, n := range nodes {
			if n.Kind == "function" {
				hasFunc = true
			}
			if n.Kind == "branch" {
				hasBranch = true
			}
			if n.Kind == "return" {
				hasReturn = true
			}
		}
		assert.True(t, hasFunc, "should find function")
		assert.True(t, hasBranch, "should find if branch")
		assert.True(t, hasReturn, "should find return statement")
	})

	t.Run("TypeScript async function with try-catch and loop", func(t *testing.T) {
		code := `export async function syncItems(items: string[]) {
  try {
    for (const item of items) {
      if (!item) continue;
      await save(item);
    }
    return true;
  } catch (err) {
    throw err;
  }
}
`
		nodes, err := engine.ExtractControlFlow(ctx, "tsx", []byte(code))
		require.NoError(t, err)
		assert.NotEmpty(t, nodes)

		var hasLoop, hasBranch, hasReturn bool
		for _, n := range nodes {
			if n.Kind == "loop" {
				hasLoop = true
			}
			if n.Kind == "branch" {
				hasBranch = true
			}
			if n.Kind == "return" {
				hasReturn = true
			}
		}
		assert.True(t, hasLoop, "should find for loop")
		assert.True(t, hasBranch, "should find branch")
		assert.True(t, hasReturn, "should find return/throw")
	})
}
