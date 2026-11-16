package archive

import (
	"context"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 归档缓存清扫（移植 apps/client/src/engine/tarball/archive-store.ts sweep）：
// - TTL：无命中超过 30 天且非活跃键 → 删除
// - 双水位：总量超高水位（4096MB）→ 按 evictionScore 升序删除至低水位
//   （3072MB）；活跃键分数 ×10（极端磁盘压力下仍可被淘汰）
// - evictionScore = (1+log2(1+hits)) · recency(age) / max(log2(2+sizeMB), 0.001)
//   recency：<7d→1.0，<30d→0.5，否则 0.1（低分=冷+低频+大，先删）
// - 活跃键（Repository.gitSha ∪ ImportRecord.sha）保护增量 diff 所需归档
// 诚实修正：Node 侧同源实现（archive-store.ts sweep）从未被调度，已随
// 死代码清理移除（2026-11）——本实现是被 daemon archive-gc 任务调度的唯一 GC。
// env 与 Node TARBALL_CACHE 同名：TARBALL_CACHE_HIGH_MB / TARBALL_CACHE_LOW_MB。
// ─────────────────────────────────────────────────────────────

const (
	sweepTTLDays      = 30
	sweepRecency7d    = 7 * 24 * time.Hour
	sweepRecency30d   = 30 * 24 * time.Hour
	sweepActiveFactor = 10.0
)

// SweepReport 单次清扫结果。
type SweepReport struct {
	Removed    int
	FreedBytes int64
}

func envMB(name string, fallback int64) int64 {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n << 20
		}
	}
	return fallback << 20
}

func sweepHighWatermark() int64 { return envMB("TARBALL_CACHE_HIGH_MB", 4096) }
func sweepLowWatermark() int64  { return envMB("TARBALL_CACHE_LOW_MB", 3072) }

type sweepEntry struct {
	owner, repo, sha string
	dir              string
	isFile           bool
	size             int64
	hits             int64
	lastHitAt        time.Time
	createdAt        time.Time
	active           bool
}

// SweepArchiveCache 清扫 {root}/{owner}/{repo}/{sha} 归档缓存。
// activeKeys 为 "owner/repo@sha" 集合（大小写不敏感比对——归档目录保留
// 导入时大小写，DB 键统一小写）。
func SweepArchiveCache(ctx context.Context, root string, activeKeys map[string]bool) (SweepReport, error) {
	report := SweepReport{}
	if root == "" {
		root = "storage/repos"
	}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return report, nil
		}
		return report, err
	}

	meta, _ := NewMetaStore(root).Load()
	now := time.Now()

	entries := make([]sweepEntry, 0, 64)
	owners, err := os.ReadDir(root)
	if err != nil {
		return report, err
	}
	for _, o := range owners {
		if !o.IsDir() || strings.HasPrefix(o.Name(), ".") {
			continue
		}
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		repos, err := os.ReadDir(filepath.Join(root, o.Name()))
		if err != nil {
			continue
		}
		for _, r := range repos {
			if !r.IsDir() {
				continue
			}
			shas, err := os.ReadDir(filepath.Join(root, o.Name(), r.Name()))
			if err != nil {
				continue
			}
			type diskShaEntry struct {
				sha       string
				entryPath string
				isFile    bool
				size      int64
				modTime   time.Time
			}
			bySha := make(map[string][]diskShaEntry)

			for _, s := range shas {
				if strings.HasPrefix(s.Name(), ".") || strings.Contains(s.Name(), ".tmp-") {
					continue
				}
				if s.IsDir() {
					sha := s.Name()
					entryPath := filepath.Join(root, o.Name(), r.Name(), sha)
					var modTime time.Time
					if st, err := os.Stat(entryPath); err == nil {
						modTime = st.ModTime()
					}
					bySha[sha] = append(bySha[sha], diskShaEntry{
						sha: sha, entryPath: entryPath, isFile: false, size: dirSize(entryPath), modTime: modTime,
					})
				} else if strings.HasSuffix(s.Name(), ".tar.gz") {
					sha := strings.TrimSuffix(s.Name(), ".tar.gz")
					entryPath := filepath.Join(root, o.Name(), r.Name(), s.Name())
					var size int64
					var modTime time.Time
					if info, err := s.Info(); err == nil {
						size = info.Size()
						modTime = info.ModTime()
					}
					bySha[sha] = append(bySha[sha], diskShaEntry{
						sha: sha, entryPath: entryPath, isFile: true, size: size, modTime: modTime,
					})
				}
			}

			for sha, list := range bySha {
				var canonical diskShaEntry
				if len(list) == 1 {
					canonical = list[0]
				} else {
					// 存在双态残留（崩溃残留），依据元数据自愈收敛为单一物理态
					key := strings.ToLower(o.Name() + "/" + r.Name() + "@" + sha)
					keepFile := true
					if m, hasMeta := meta[key]; hasMeta {
						keepFile = m.Compacted
					}
					for _, item := range list {
						if item.isFile == keepFile {
							canonical = item
						} else {
							if item.isFile {
								_ = os.Remove(item.entryPath)
							} else {
								_ = os.RemoveAll(item.entryPath)
							}
						}
					}
				}

				key := strings.ToLower(o.Name() + "/" + r.Name() + "@" + sha)
				entry := sweepEntry{
					owner: o.Name(), repo: r.Name(), sha: sha,
					dir: canonical.entryPath, isFile: canonical.isFile, active: activeKeys[key],
				}
				if m, ok := meta[key]; ok {
					entry.hits = m.Hits
					entry.lastHitAt = time.UnixMilli(m.LastHitAt)
					entry.createdAt = time.UnixMilli(m.CreatedAt)
				} else {
					entry.lastHitAt = canonical.modTime
					entry.createdAt = canonical.modTime
				}
				entry.size = canonical.size
				entries = append(entries, entry)
			}
		}
	}

	remove := map[string]bool{} // key → 删除

	// Pass 1: TTL（无命中 > 30 天且非活跃）
	for _, e := range entries {
		if e.active {
			continue
		}
		if now.Sub(e.lastHitAt) > time.Duration(sweepTTLDays)*24*time.Hour {
			remove[e.owner+"/"+e.repo+"@"+e.sha] = true
		}
	}

	// Pass 2: 双水位淘汰
	var total int64
	for _, e := range entries {
		if !remove[e.owner+"/"+e.repo+"@"+e.sha] {
			total += e.size
		}
	}
	if total > sweepHighWatermark() {
		// 复制并按 (活跃×10 加权后的) 分数升序——低分先删
		order := make([]sweepEntry, len(entries))
		copy(order, entries)
		score := func(e sweepEntry) float64 {
			return evictionScore(e.hits, now.Sub(e.lastHitAt), e.size) * boolWeight(e.active)
		}
		// 简单插入排序键（条目量级为百，无需 sort.Slice 依赖闭包捕获歧义）
		for i := 1; i < len(order); i++ {
			for j := i; j > 0; j-- {
				if score(order[j]) < score(order[j-1]) {
					order[j], order[j-1] = order[j-1], order[j]
				} else {
					break
				}
			}
		}
		for _, e := range order {
			if total <= sweepLowWatermark() {
				break
			}
			key := e.owner + "/" + e.repo + "@" + e.sha
			if remove[key] {
				continue // TTL 已删，总量已扣除
			}
			remove[key] = true
			total -= e.size
		}
	}

	// 执行删除 + 元数据同步
	metaChanged := false
	for _, e := range entries {
		key := e.owner + "/" + e.repo + "@" + e.sha
		if !remove[key] {
			continue
		}
		var err error
		if e.isFile {
			err = os.Remove(e.dir)
		} else {
			err = os.RemoveAll(e.dir)
		}
		if err != nil {
			log.Printf("[archive-sweep] remove %s failed: %v", key, err)
			continue
		}
		report.Removed++
		report.FreedBytes += e.size
		lowerKey := strings.ToLower(key)
		if _, ok := meta[lowerKey]; ok {
			delete(meta, lowerKey)
			metaChanged = true
		}
	}

	if report.Removed > 0 {
		// 空仓目录顺手回收
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || !d.IsDir() {
				return nil
			}
			if path == root {
				return nil
			}
			if empty, _ := isEmptyDir(path); empty {
				_ = os.Remove(path)
			}
			return nil
		})
	}

	if metaChanged {
		// 共享管理器：删除目录后立即刷盘，磁盘文件不再引用已删目录
		if err := NewMetaStore(root).Update(func(m MetaStore) bool {
			for k := range m {
				if remove[strings.ToLower(k)] {
					delete(m, k)
				}
			}
			return true
		}); err != nil {
			log.Printf("[archive-sweep] metadata update failed: %v", err)
		} else if err := NewMetaStore(root).Flush(); err != nil {
			log.Printf("[archive-sweep] metadata flush failed: %v", err)
		}
	}
	return report, nil
}

// evictionScore 淘汰分数（低分先删）：热度 × 新鲜度 / 体积。
func evictionScore(hits int64, age time.Duration, sizeBytes int64) float64 {
	sizeMB := float64(sizeBytes) / (1 << 20)
	recency := 0.1
	switch {
	case age < sweepRecency7d:
		recency = 1.0
	case age < sweepRecency30d:
		recency = 0.5
	}
	denom := math.Log2(2+sizeMB)
	if denom < 0.001 {
		denom = 0.001
	}
	return (1 + math.Log2(1+float64(hits))) * recency / denom
}

func boolWeight(active bool) float64 {
	if active {
		return sweepActiveFactor
	}
	return 1.0
}

func dirSize(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func isEmptyDir(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}
