package archive

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	DefaultMinFreeDiskMB = 1024
)

func ReadMinFreeDiskMB() int {
	if v := strings.TrimSpace(os.Getenv("ARCHIVE_MIN_FREE_DISK_MB")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultMinFreeDiskMB
}

func CheckFreeDiskSpace(path string) (uint64, error) {
	target := path
	if target == "" {
		target = "."
	}
	for target != "" && target != "." && target != "/" {
		if st, err := os.Stat(target); err == nil && st.IsDir() {
			break
		}
		target = filepath.Dir(target)
	}
	if target == "" || target == "." {
		target = "."
	}

	var stat unix.Statfs_t
	if err := unix.Statfs(target, &stat); err != nil {
		return 0, fmt.Errorf("statfs failed for %s: %w", target, err)
	}

	freeBytes := stat.Bavail * uint64(stat.Bsize)
	return freeBytes, nil
}

// Fail closed before unpack if disk stays below requiredMB even after triggering cold cache sweep.
func EnsureDiskSpaceForArchive(ctx context.Context, root string, requiredMB int64, activeKeys map[string]bool) (uint64, error) {
	if requiredMB <= 0 {
		requiredMB = DefaultMinFreeDiskMB
	}
	requiredBytes := uint64(requiredMB) << 20

	freeBytes, err := CheckFreeDiskSpace(root)
	if err != nil {
		log.Printf("[archive-disk] statfs warning for %s (proceeding): %v", root, err)
		return 0, nil // Fail open when filesystem statfs is unsupported (e.g. virtualized FS).
	}

	if freeBytes >= requiredBytes {
		return freeBytes, nil
	}

	freeMB := freeBytes >> 20
	log.Printf("[archive-disk] low disk space detected: %d MB free < %d MB required; triggering proactive cache sweep", freeMB, requiredMB)

	report, sweepErr := SweepArchiveCache(ctx, root, activeKeys)
	if sweepErr != nil {
		log.Printf("[archive-disk] proactive sweep warning: %v", sweepErr)
	} else if report.Removed > 0 {
		log.Printf("[archive-disk] proactive sweep removed %d archives, freed %d bytes (%.2f MB)",
			report.Removed, report.FreedBytes, float64(report.FreedBytes)/(1024*1024))
	}

	freeBytes, err = CheckFreeDiskSpace(root)
	if err != nil {
		return 0, nil
	}
	if freeBytes < requiredBytes {
		return freeBytes, fmt.Errorf("archive ensure: insufficient disk space on %s (%d MB available < %d MB required); aborted to protect host system",
			root, freeBytes>>20, requiredMB)
	}

	return freeBytes, nil
}
