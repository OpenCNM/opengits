package valley

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeStore struct {
	hours [24]int
	err   error
	calls int
}

func (f *fakeStore) HourlyCallCounts(_ context.Context, _ time.Time, _ int) ([24]int, error) {
	f.calls++
	return f.hours, f.err
}

func TestFindWindow(t *testing.T) {
	tests := []struct {
		name  string
		hours [24]int
		minH  int
		maxH  int
		want  Window
	}{
		{
			name:  "白天单峰低谷在凌晨",
			hours: [24]int{0, 0, 0, 0, 0, 0, 8, 12, 35, 24, 1583, 4, 5, 35, 40, 21, 15, 24, 0, 0, 0, 0, 0, 0},
			want:  Window{StartHour: 0, LenHours: 6},
		},
		{
			name: "低谷跨午夜",
			hours: func() [24]int {
				var h [24]int
				for i := 2; i <= 21; i++ {
					h[i] = 100
				}
				return h
			}(),
			want: Window{StartHour: 22, LenHours: 4},
		},
		{
			name:  "全零同分取最长窗口",
			hours: [24]int{},
			want:  Window{StartHour: 0, LenHours: 6},
		},
		{
			name: "夜间持续低谷但上限6小时",
			hours: func() [24]int {
				var h [24]int
				for i := 0; i < 9; i++ {
					h[i] = 1
				}
				for i := 9; i < 24; i++ {
					h[i] = 50
				}
				return h
			}(),
			want: Window{StartHour: 0, LenHours: 6},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindWindow(tt.hours, 2, 6)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestWindowContains(t *testing.T) {
	tests := []struct {
		name   string
		window Window
		hour   int
		want   bool
	}{
		{"窗口起点包含", Window{1, 4}, 1, true},
		{"窗口中段包含", Window{1, 4}, 3, true},
		{"窗口末端不含（左闭右开）", Window{1, 4}, 5, false},
		{"跨午夜前段", Window{23, 3}, 23, true},
		{"跨午夜后段", Window{23, 3}, 1, true},
		{"跨午夜界外", Window{23, 3}, 2, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := time.Date(2026, 10, 20, tt.hour, 30, 0, 0, time.UTC)
			assert.Equal(t, tt.want, tt.window.Contains(ts))
		})
	}
}

func TestAnalyzerFailClosedAndCache(t *testing.T) {
	loc := time.FixedZone("UTC+8", 8*3600)
	base := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

	t.Run("样本不足回落保守窗口", func(t *testing.T) {
		fs := &fakeStore{hours: [24]int{0: 3, 10: 4}}
		a := NewAnalyzer(fs, loc, 14, 2, 6)
		w, samples, thin := a.Window(context.Background(), base)
		assert.True(t, thin)
		assert.Equal(t, 7, samples)
		assert.Equal(t, Window{StartHour: 0, LenHours: 5}, w, "thin 必须 fallback，不得用数据判窗")
	})

	t.Run("查询失败首败回落_带旧窗口沿用", func(t *testing.T) {
		fs := &fakeStore{err: errors.New("db down")}
		a := NewAnalyzer(fs, loc, 14, 2, 6)
		w, _, _ := a.Window(context.Background(), base)
		assert.Equal(t, Window{StartHour: 0, LenHours: 5}, w, "无历史窗口时失败必须 fallback")

		fs.err = nil
		fs.hours = [24]int{0: 0, 2: 0, 15: 999}
		w2, _, _ := a.Window(context.Background(), base.Add(30*time.Minute))
		assert.Equal(t, w, w2, "重试窗口内应命中缓存")
		assert.Equal(t, 1, fs.calls, "缓存期内不得重复查询")

		w3, _, thin := a.Window(context.Background(), base.Add(61*time.Minute))
		assert.False(t, thin)
		assert.Equal(t, 2, fs.calls)
		assert.NotEqual(t, Window{StartHour: 0, LenHours: 5}, w3)
	})

	t.Run("成功后24h内命中缓存", func(t *testing.T) {
		fs := &fakeStore{hours: [24]int{0: 0, 3: 0, 12: 800}}
		a := NewAnalyzer(fs, loc, 14, 2, 6)
		_, _, _ = a.Window(context.Background(), base)
		_, _, _ = a.Window(context.Background(), base.Add(23*time.Hour))
		assert.Equal(t, 1, fs.calls, "24h 内应命中缓存")
		_, _, _ = a.Window(context.Background(), base.Add(25*time.Hour))
		assert.Equal(t, 2, fs.calls, "过期应重算")
	})

	t.Run("InWindow按目标时区判定", func(t *testing.T) {
		fs := &fakeStore{hours: [24]int{0: 1, 10: 4}}
		a := NewAnalyzer(fs, loc, 14, 2, 6)
		assert.True(t, a.InWindow(context.Background(), time.Date(2026, 10, 20, 16, 0, 0, 0, time.UTC)))
		assert.True(t, a.InWindow(context.Background(), time.Date(2026, 10, 20, 20, 30, 0, 0, time.UTC)))
		assert.False(t, a.InWindow(context.Background(), time.Date(2026, 10, 20, 21, 0, 0, 0, time.UTC)))
	})
}

func TestPgxStoreSignature(t *testing.T) {
	var _ Store = (*PgxStore)(nil)
	require.True(t, true)
}
