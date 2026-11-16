package archive

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 派生产物磁盘清扫（storage/graphs & storage/treemaps）：
// 产物为 {dir}/{owner}/{repo}/{sha}.json 单文件（内容寻址、原则不可变，
// "head" 伪 sha 覆写自刷新 mtime）。与 repos 归档不同：无 MetaStore 命中
// 元数据，mtime 即写入时间——不可变产物的 mtime 天然等价最后访问下界。
// - 活跃键（Repository.gitSha ∪ ImportRecord.sha，与 SweepArchiveCache
//   同源）：正典/导入中产物严格保护（graph 重建昂贵：RSG 全量管线）
// - 非活跃且 mtime 超 TTL → 物理删除；tmp 原子写残骸（*.tmp-pid）同 TTL 清
// - TTL：Graph 30d / Treemap 14d（treemap 重建廉价：树折叠，可更短）
// - 消费方进程内 LRU（cognitive 包）命中前 mtime+size 校验，删除自愈，
//   无需跨包失效广播（失效封闭：不引入反向依赖）
// ─────────────────────────────────────────────────────────────

const (
	GraphArtifactTTL   = 30 * 24 * time.Hour
	TreeMapArtifactTTL = 14 * 24 * time.Hour
)

// SweepArtifactFiles 清扫 {dir}/{owner}/{repo}/{sha}.json 派生产物，
// 删除非活跃且超 TTL 的文件与 tmp 残骸，并回收空目录。
// activeKeys 为 "owner/repo@sha" 集合（大小写不敏感比对——磁盘保留导入
// 时大小写，DB 键统一小写，与 SweepArchiveCache 口径一致）。
func SweepArtifactFiles(ctx context.Context, dir string, activeKeys map[string]bool, ttl time.Duration) (SweepReport, error) {
	report := SweepReport{}
	if dir == "" {
		return report, nil
	}
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return report, nil
		}
		return report, err
	}

	now := time.Now()
	owners, err := os.ReadDir(dir)
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
		repos, err := os.ReadDir(filepath.Join(dir, o.Name()))
		if err != nil {
			continue
		}
		for _, r := range repos {
			if !r.IsDir() {
				continue
			}
			files, err := os.ReadDir(filepath.Join(dir, o.Name(), r.Name()))
			if err != nil {
				continue
			}
			for _, f := range files {
				if f.IsDir() {
					continue
				}
				info, err := f.Info()
				if err != nil {
					continue
				}
				name := f.Name()
				path := filepath.Join(dir, o.Name(), r.Name(), name)

				// 原子写残骸（无 sha 语义、永不生效）：仅按陈旧度清理
				if strings.Contains(name, ".tmp-") {
					if now.Sub(info.ModTime()) > ttl {
						if err := os.Remove(path); err != nil {
							log.Printf("[artifact-sweep] remove tmp debris %s failed: %v", path, err)
							continue
						}
						report.Removed++
						report.FreedBytes += info.Size()
					}
					continue
				}
				if !strings.HasSuffix(name, ".json") {
					continue
				}
				sha := strings.TrimSuffix(name, ".json")
				if activeKeys[strings.ToLower(o.Name()+"/"+r.Name()+"@"+sha)] {
					continue
				}
				if now.Sub(info.ModTime()) > ttl {
					if err := os.Remove(path); err != nil {
						log.Printf("[artifact-sweep] remove %s failed: %v", path, err)
						continue
					}
					report.Removed++
					report.FreedBytes += info.Size()
				}
			}
		}
	}

	if report.Removed > 0 {
		// 空仓目录顺手回收（WalkDir 自顶向下：本轮清 repo 层，owner 层
		// 残留由下轮有删除发生的清扫补收——与 SweepArchiveCache 同口径）
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || !d.IsDir() || path == dir {
				return nil
			}
			if empty, _ := isEmptyDir(path); empty {
				_ = os.Remove(path)
			}
			return nil
		})
	}
	return report, nil
}
