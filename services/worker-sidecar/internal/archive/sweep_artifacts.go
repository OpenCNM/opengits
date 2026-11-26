package archive

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Use file mtime as access lower bound for immutable content-addressed artifacts (30d graph / 14d treemap TTL).

const (
	GraphArtifactTTL   = 30 * 24 * time.Hour
	TreeMapArtifactTTL = 14 * 24 * time.Hour
)

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
