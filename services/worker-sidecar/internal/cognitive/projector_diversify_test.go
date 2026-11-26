package cognitive

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type diversifyFixture struct {
	phase  CognitivePhase
	name   string
	upsets map[string][]string
}

func newDiversifyModules(t *testing.T, f diversifyFixture, names ...string) []ProjectedModule {
	t.Helper()
	mods := make([]ProjectedModule, 0, len(names))
	for _, name := range names {
		mods = append(mods, ProjectedModule{
			Name:               name,
			Phase:              f.phase,
			PhaseOrder:         4,
			CognitiveRationale: "orig",
			UpstreamModules:    f.upsets[name],
		})
	}
	return mods
}

func phaseOrders(mods []ProjectedModule) []int {
	out := make([]int, 0, len(mods))
	for _, m := range mods {
		out = append(out, m.PhaseOrder)
	}
	return out
}

func untouched(mods []ProjectedModule) bool {
	for _, m := range mods {
		if m.PhaseOrder != 4 || m.CognitiveRationale != "orig" {
			return false
		}
	}
	return true
}

func byName(mods []ProjectedModule, name string) ProjectedModule {
	for _, m := range mods {
		if m.Name == name {
			return m
		}
	}
	return ProjectedModule{}
}

func TestDiversifyCollapsedPhases(t *testing.T) {
	t.Helper()
	tests := []struct {
		name       string
		names      []string
		upsets     map[string][]string
		wantOrders []int
	}{
		{
			name:       "Adapter 四元链：Entity → Pipeline → 保留 Adapter",
			names:      []string{"m00", "m01", "m02", "m03"},
			upsets:     map[string][]string{"m01": {"m00"}, "m02": {"m01"}, "m03": {"m02"}},
			wantOrders: []int{2, 3, 4, 4},
		},
		{
			name:  "两层 DAG：同 tier 不拆开",
			names: []string{"A0", "A1", "A2", "A3", "A4", "B0", "B1", "B2", "B3", "B4"},
			upsets: map[string][]string{
				"B0": {"A0"}, "B1": {"A1"}, "B2": {"A2"}, "B3": {"A3"}, "B4": {"A4"},
			},
			wantOrders: []int{2, 2, 2, 2, 2, 4, 4, 4, 4, 4},
		},
		{
			name:       "九个孤立模块 + 一条边：孤立模块保持原相位",
			names:      []string{"m00", "m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09"},
			upsets:     map[string][]string{"m01": {"m00"}},
			wantOrders: []int{2, 4, 4, 4, 4, 4, 4, 4, 4, 4},
		},
		{
			name:       "环：同环同层，不被拆到不同相位",
			names:      []string{"A", "B", "C", "D"},
			upsets:     map[string][]string{"A": {"B"}, "B": {"A"}, "C": {"B"}, "D": {"C"}},
			wantOrders: []int{2, 2, 3, 4},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: tt.upsets}, tt.names...)
			diversifyCollapsedPhases(mods)
			assert.Equal(t, tt.wantOrders, phaseOrders(mods))
		})
	}

	t.Run("rationale 只陈述可验证事实", func(t *testing.T) {
		mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: map[string][]string{"m01": {"m00"}}}, "m00", "m01", "m02")
		diversifyCollapsedPhases(mods)
		assert.Equal(t, "Re-tiered from a collapsed adapter gradient by dependency topology: depth 0, 1 in-set dependents.", mods[0].CognitiveRationale)
		assert.Equal(t, "Retained adapter tier after dependency-topology re-tiering: depth 1, 0 in-set dependents.", mods[1].CognitiveRationale)
		assert.Equal(t, "orig", mods[2].CognitiveRationale, "孤立模块不改 rationale")
	})

	t.Run("孤立模块的 rationale 不得声称被下游依赖", func(t *testing.T) {
		mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: map[string][]string{"m01": {"m00"}}}, "m00", "m01", "m02")
		diversifyCollapsedPhases(mods)
		assert.NotContains(t, mods[2].CognitiveRationale, "dependents")
	})

	t.Run("纯环不产生梯度", func(t *testing.T) {
		mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: map[string][]string{"A": {"C"}, "B": {"A"}, "C": {"B"}}}, "A", "B", "C")
		diversifyCollapsedPhases(mods)
		assert.True(t, untouched(mods), "单一 tier 的链上集合没有梯度可重建")
	})

	t.Run("Entity 坍缩保持原样", func(t *testing.T) {
		mods := newDiversifyModules(t, diversifyFixture{phase: PhaseEntity, upsets: map[string][]string{"m01": {"m00"}, "m02": {"m01"}, "m03": {"m02"}}}, "m00", "m01", "m02", "m03")
		diversifyCollapsedPhases(mods)
		assert.True(t, untouched(mods))
		for _, m := range mods {
			assert.Equal(t, PhaseEntity, m.Phase)
		}
	})

	t.Run("Pipeline 坍缩保持原样", func(t *testing.T) {
		upsets := map[string][]string{}
		for i := 0; i < 9; i++ {
			upsets["m09"] = append(upsets["m09"], fmt.Sprintf("m%02d", i))
		}
		mods := newDiversifyModules(t, diversifyFixture{phase: PhasePipeline, upsets: upsets},
			"m00", "m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09")
		diversifyCollapsedPhases(mods)
		assert.True(t, untouched(mods))
		for _, m := range mods {
			assert.Equal(t, PhasePipeline, m.Phase)
		}
	})

	t.Run("恰好 2/3 不触发", func(t *testing.T) {
		mods := []ProjectedModule{
			{Name: "a", Phase: PhaseAdapter, PhaseOrder: 4, CognitiveRationale: "orig", UpstreamModules: []string{"b"}},
			{Name: "b", Phase: PhaseAdapter, PhaseOrder: 4, CognitiveRationale: "orig"},
			{Name: "c", Phase: PhaseAdapter, PhaseOrder: 4, CognitiveRationale: "orig"},
			{Name: "d", Phase: PhaseAdapter, PhaseOrder: 4, CognitiveRationale: "orig"},
			{Name: "e", Phase: PhaseEntity, PhaseOrder: 2, CognitiveRationale: "orig"},
			{Name: "f", Phase: PhasePipeline, PhaseOrder: 3, CognitiveRationale: "orig"},
		}
		diversifyCollapsedPhases(mods)
		for _, name := range []string{"a", "b", "c", "d"} {
			assert.Equal(t, 4, byName(mods, name).PhaseOrder, name)
			assert.Equal(t, "orig", byName(mods, name).CognitiveRationale, name)
		}
		assert.Equal(t, 2, byName(mods, "e").PhaseOrder)
		assert.Equal(t, 3, byName(mods, "f").PhaseOrder)
	})

	t.Run("少于 3 个模块不触发", func(t *testing.T) {
		mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: map[string][]string{"m01": {"m00"}}}, "m00", "m01")
		diversifyCollapsedPhases(mods)
		assert.True(t, untouched(mods))
	})
}

func TestDiversifyCollapsedPhasesDeterministic(t *testing.T) {
	t.Helper()
	build := func() []ProjectedModule {
		mods := []ProjectedModule{}
		for i := 0; i < 10; i++ {
			mods = append(mods, ProjectedModule{Name: fmt.Sprintf("m%02d", i), Phase: PhaseAdapter, PhaseOrder: 4, CognitiveRationale: "orig"})
		}
		mods[3].UpstreamModules = []string{"m07"}
		mods[5].UpstreamModules = []string{"m03"}
		mods[9].Phase = PhaseEntity
		mods[9].PhaseOrder = 2
		return mods
	}
	first := build()
	diversifyCollapsedPhases(first)
	for round := 0; round < 50; round++ {
		again := build()
		diversifyCollapsedPhases(again)
		require.Equal(t, phaseOrders(first), phaseOrders(again))
		require.Equal(t, first[7].CognitiveRationale, again[7].CognitiveRationale)
	}
}

func TestDiversifyCollapsedPhasesMonotonic(t *testing.T) {
	t.Helper()
	upsets := map[string][]string{}
	names := []string{}
	for i := 0; i < 12; i++ {
		name := fmt.Sprintf("m%02d", i)
		names = append(names, name)
		if i > 0 {
			upsets[name] = []string{fmt.Sprintf("m%02d", (i-1)%3), fmt.Sprintf("m%02d", (i*5+1)%12)}
		}
	}
	mods := newDiversifyModules(t, diversifyFixture{phase: PhaseAdapter, upsets: upsets}, names...)
	diversifyCollapsedPhases(mods)
	byName := map[string]ProjectedModule{}
	for _, m := range mods {
		byName[m.Name] = m
	}
	for name, m := range byName {
		for _, up := range m.UpstreamModules {
			assert.LessOrEqual(t, byName[up].PhaseOrder, m.PhaseOrder, "上游 %s 不得排在下游 %s 之后", up, name)
		}
	}
}
