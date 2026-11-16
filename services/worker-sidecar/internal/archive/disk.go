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
	// DefaultMinFreeDiskMB 默认解包最低剩余磁盘保护空间（1024MB = 1GB）。
	DefaultMinFreeDiskMB = 1024
)

// ReadMinFreeDiskMB 从环境变量 ARCHIVE_MIN_FREE_DISK_MB 读取磁盘保护阈值（MB）。
func ReadMinFreeDiskMB() int {
	if v := strings.TrimSpace(os.Getenv("ARCHIVE_MIN_FREE_DISK_MB")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultMinFreeDiskMB
}

// CheckFreeDiskSpace 检查指定路径所在文件系统的可用磁盘字节数（Bytes）。
// 若目标路径尚不存在，递归探测其父目录直至根目录。
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

// EnsureDiskSpaceForArchive 在下载/解压归档前执行磁盘熔断保护：
// 1. 检查 root 可用空间；
// 2. 若低于 requiredMB，主动触发 SweepArchiveCache 清理冷数据；
// 3. 复查可用空间；若仍然低于安全底线，Fail-Closed 拒绝解压并报错，绝不撑爆物理盘。
func EnsureDiskSpaceForArchive(ctx context.Context, root string, requiredMB int64, activeKeys map[string]bool) (uint64, error) {
	if requiredMB <= 0 {
		requiredMB = DefaultMinFreeDiskMB
	}
	requiredBytes := uint64(requiredMB) << 20

	freeBytes, err := CheckFreeDiskSpace(root)
	if err != nil {
		log.Printf("[archive-disk] statfs warning for %s (proceeding): %v", root, err)
		return 0, nil // fail-open on virtualized/unsupported fs
	}

	if freeBytes >= requiredBytes {
		return freeBytes, nil
	}

	freeMB := freeBytes >> 20
	log.Printf("[archive-disk] low disk space detected: %d MB free < %d MB required; triggering proactive cache sweep", freeMB, requiredMB)

	// 空间不足，主动触发一轮归档双水位清扫
	report, sweepErr := SweepArchiveCache(ctx, root, activeKeys)
	if sweepErr != nil {
		log.Printf("[archive-disk] proactive sweep warning: %v", sweepErr)
	} else if report.Removed > 0 {
		log.Printf("[archive-disk] proactive sweep removed %d archives, freed %d bytes (%.2f MB)",
			report.Removed, report.FreedBytes, float64(report.FreedBytes)/(1024*1024))
	}

	// 再次复查
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
