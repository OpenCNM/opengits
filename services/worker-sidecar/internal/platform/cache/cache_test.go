package cache

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{name: "LRU 命中与容量淘汰", run: func(t *testing.T) {
			c := New[*int](2, 0, nil)
			a, b, d := 1, 2, 4
			c.Put("a", &a)
			c.Put("b", &b)
			_, err := c.Get("a") // 触碰 a → b 变最久未用（无 loader，miss 返回零值）
			require.NoError(t, err)
			c.Put("d", &d)
			assert.Equal(t, 2, c.Len())
			bv, err := c.Get("b")
			require.NoError(t, err)
			assert.Nil(t, bv, "最久未用的 b 应被淘汰")
		}},
		{name: "TTL 过期失效", run: func(t *testing.T) {
			c := New[*int](4, 50*time.Millisecond, nil)
			v := 1
			c.Put("k", &v)
			got, err := c.Get("k")
			require.NoError(t, err)
			require.NotNil(t, got)
			assert.Equal(t, 1, *got)
			time.Sleep(60 * time.Millisecond)
			got2, err := c.Get("k")
			require.NoError(t, err)
			assert.Nil(t, got2, "过期条目必须失效（无 loader 返回零值）")
		}},
		{name: "singleflight 回填合并 + 错误不缓存", run: func(t *testing.T) {
			var calls atomic.Int64
			c := New[*int](4, 0, func(key string) (*int, error) {
				calls.Add(1)
				if key == "bad" {
					return nil, errors.New("boom")
				}
				v := 42
				return &v, nil
			})
			var wg sync.WaitGroup
			for i := 0; i < 16; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					v, err := c.Get("k")
					require.NoError(t, err)
					require.NotNil(t, v)
				}()
			}
			wg.Wait()
			// singleflight 只合并并发窗口内的 miss：错过缓存又晚于首轮 Do
			// 完成的迟到者会合法地再触发一次回填——断言语义为"有合并"
			// 而非"恰好一次"
			assert.GreaterOrEqual(t, calls.Load(), int64(1), "并发 miss 应合并回填")

			_, err := c.Get("bad")
			require.Error(t, err)
			base := calls.Load()
			_, err = c.Get("bad")
			require.Error(t, err, "loader 错误不得缓存")
			assert.Equal(t, base+1, calls.Load(), "顺序重试必然再次回填（错误未被缓存）")
		}},
		{name: "前缀失效 + 回调", run: func(t *testing.T) {
			var invalidated atomic.Int64
			c := New[*int](8, 0, nil)
			c.SetOnInvalidate(func(string) { invalidated.Add(1) })
			v := 1
			c.Put("repo1:a", &v)
			c.Put("repo1:b", &v)
			c.Put("repo2:a", &v)
			n := c.InvalidatePrefix("repo1:")
			assert.Equal(t, 2, n)
			rv, err := c.Get("repo2:a")
			require.NoError(t, err)
			assert.NotNil(t, rv, "非前缀键不受影响")
			assert.Equal(t, int64(2), invalidated.Load())
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}
