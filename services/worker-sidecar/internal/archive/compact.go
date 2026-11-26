package archive

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const DefaultArchiveAutoCompactThresholdBytes = 30 * 1024 * 1024

var ErrFileTooLarge = errors.New("file exceeds maximum size limit")

func ArchiveAutoCompactThresholdBytes() int64 {
	if val := strings.TrimSpace(os.Getenv("ARCHIVE_AUTO_COMPACT_MIN_MB")); val != "" {
		if mb, err := strconv.ParseInt(val, 10, 64); err == nil && mb > 0 {
			return mb * 1024 * 1024
		}
	}
	return DefaultArchiveAutoCompactThresholdBytes
}

func CompactArchivePathFor(root, owner, repo, sha string) string {
	if root == "" {
		root = "storage/repos"
	}
	return ArchiveDirFor(root, owner, repo, sha) + ".tar.gz"
}

// Shard compact locks across 128 fixed mutexes to bound memory without an unbounded lock map.
var compactLocks [128]sync.Mutex

func getArchiveCompactLock(owner, repo, sha string) *sync.Mutex {
	key := archiveKey(owner, repo, sha)
	var h uint64 = 14695981039346656037
	for i := 0; i < len(key); i++ {
		h ^= uint64(key[i])
		h *= 1099511628211
	}
	return &compactLocks[h%128]
}

func isValidGzip(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	magic := make([]byte, 2)
	n, _ := io.ReadFull(f, magic)
	return n == 2 && magic[0] == 0x1f && magic[1] == 0x8b
}

func CompactArchive(ctx context.Context, archiveRoot, owner, repo, sha string) (int64, error) {
	if err := AssertSafeArchiveSegments(owner, repo, sha); err != nil {
		return 0, err
	}
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}

	lock := getArchiveCompactLock(owner, repo, sha)
	lock.Lock()
	defer lock.Unlock()

	expandedDir := ArchiveDirFor(archiveRoot, owner, repo, sha)
	compactPath := CompactArchivePathFor(archiveRoot, owner, repo, sha)

	if cst, cerr := os.Stat(compactPath); cerr == nil && !cst.IsDir() && cst.Size() > 0 {
		if isValidGzip(compactPath) {
			if _, err := os.Stat(expandedDir); err == nil {
				_ = os.RemoveAll(expandedDir)
			}
			return cst.Size(), nil
		}
	}

	st, err := os.Stat(expandedDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, fmt.Errorf("expanded archive directory does not exist: %s", expandedDir)
		}
		return 0, err
	}
	if !st.IsDir() {
		return 0, fmt.Errorf("archive path is not a directory: %s", expandedDir)
	}

	entries, err := os.ReadDir(expandedDir)
	if err != nil {
		return 0, fmt.Errorf("read archive directory failed: %w", err)
	}
	if len(entries) == 0 {
		return 0, fmt.Errorf("refusing to compact empty directory: %s", expandedDir)
	}

	if err := os.MkdirAll(filepath.Dir(compactPath), 0o755); err != nil {
		return 0, fmt.Errorf("create compact parent dir failed: %w", err)
	}

	tmpPath := fmt.Sprintf("%s.tmp-%d-%s", compactPath, time.Now().UnixNano(), randomArchiveSuffix())
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, fmt.Errorf("create temp compact file failed: %w", err)
	}

	success := false
	defer func() {
		if !success {
			_ = tmpFile.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	gw, err := gzip.NewWriterLevel(tmpFile, gzip.BestSpeed)
	if err != nil {
		tmpFile.Close()
		return 0, fmt.Errorf("create gzip writer failed: %w", err)
	}
	tw := tar.NewWriter(gw)

	walkErr := filepath.WalkDir(expandedDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == expandedDir {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		rel, err := filepath.Rel(expandedDir, p)
		if err != nil {
			return err
		}
		relSlash := filepath.ToSlash(rel)

		info, err := d.Info()
		if err != nil {
			return err
		}

		mode := info.Mode()
		if !mode.IsDir() && !mode.IsRegular() && (mode&os.ModeSymlink == 0) {
			return nil
		}

		linkTarget := ""
		if mode&os.ModeSymlink != 0 {
			linkTarget, err = os.Readlink(p)
			if err != nil {
				return err
			}
		}

		hdr, err := tar.FileInfoHeader(info, linkTarget)
		if err != nil {
			return err
		}
		hdr.Name = relSlash
		if d.IsDir() && !strings.HasSuffix(hdr.Name, "/") {
			hdr.Name += "/"
		}

		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}

		if mode.IsRegular() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(tw, f)
			f.Close()
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	})

	if walkErr != nil {
		_ = tw.Close()
		_ = gw.Close()
		_ = tmpFile.Close()
		return 0, fmt.Errorf("tar archive failed: %w", walkErr)
	}

	if err := tw.Close(); err != nil {
		_ = gw.Close()
		_ = tmpFile.Close()
		return 0, fmt.Errorf("close tar writer failed: %w", err)
	}
	if err := gw.Close(); err != nil {
		_ = tmpFile.Close()
		return 0, fmt.Errorf("close gzip writer failed: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return 0, fmt.Errorf("sync temp file failed: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return 0, fmt.Errorf("close temp file failed: %w", err)
	}

	tmpStat, err := os.Stat(tmpPath)
	if err != nil || tmpStat.Size() == 0 {
		return 0, fmt.Errorf("compact file verification failed: %v", err)
	}

	headerCheck, err := os.Open(tmpPath)
	if err != nil {
		return 0, fmt.Errorf("verify compact file open failed: %w", err)
	}
	magic := make([]byte, 2)
	n, _ := io.ReadFull(headerCheck, magic)
	headerCheck.Close()
	if n < 2 || magic[0] != 0x1f || magic[1] != 0x8b {
		return 0, errors.New("compact archive validation failed: invalid gzip header")
	}

	if err := os.Rename(tmpPath, compactPath); err != nil {
		return 0, fmt.Errorf("rename compact file failed: %w", err)
	}
	success = true

	if err := os.RemoveAll(expandedDir); err != nil {
		log.Printf("[archive-compact] warning: remove expanded dir %s failed: %v", expandedDir, err)
	}

	compactedSize := tmpStat.Size()
	metaStore := NewMetaStore(archiveRoot)
	now := time.Now().UnixMilli()
	_ = metaStore.Update(func(meta MetaStore) bool {
		key := archiveKey(owner, repo, sha)
		entry, ok := meta[key]
		if !ok {
			entry = ArchiveMeta{
				Owner:     owner,
				Repo:      repo,
				Sha:       sha,
				CreatedAt: now,
			}
		}
		entry.Size = compactedSize
		entry.Compacted = true
		entry.LastHitAt = now
		meta[key] = entry
		return true
	})
	_ = metaStore.Flush()

	return compactedSize, nil
}

func DecompactArchive(ctx context.Context, archiveRoot, owner, repo, sha string) (string, error) {
	if err := AssertSafeArchiveSegments(owner, repo, sha); err != nil {
		return "", err
	}
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}

	lock := getArchiveCompactLock(owner, repo, sha)
	lock.Lock()
	defer lock.Unlock()

	expandedDir := ArchiveDirFor(archiveRoot, owner, repo, sha)
	compactPath := CompactArchivePathFor(archiveRoot, owner, repo, sha)

	if st, err := os.Stat(expandedDir); err == nil && st.IsDir() {
		if entries, err := os.ReadDir(expandedDir); err == nil && len(entries) > 0 {
			_ = os.Remove(compactPath)
			return expandedDir, nil
		}
	}

	cst, err := os.Stat(compactPath)
	if err != nil {
		return "", fmt.Errorf("compact archive not found: %s (%w)", compactPath, err)
	}
	if cst.IsDir() {
		return "", fmt.Errorf("compact archive path is a directory: %s", compactPath)
	}

	tmpDir := fmt.Sprintf("%s.tmp-%d-%s", expandedDir, time.Now().UnixNano(), randomArchiveSuffix())
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return "", fmt.Errorf("create temp decompact dir failed: %w", err)
	}

	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	f, err := os.Open(compactPath)
	if err != nil {
		return "", fmt.Errorf("open compact archive failed: %w", err)
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("create gzip reader failed: %w", err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read tar entry failed: %w", err)
		}

		cleanName := filepath.Clean(hdr.Name)
		if strings.HasPrefix(cleanName, "/") || strings.HasPrefix(cleanName, "\\") || strings.Contains(cleanName, "..") {
			return "", fmt.Errorf("unsafe entry path in archive: %s", hdr.Name)
		}

		targetPath := filepath.Join(tmpDir, filepath.FromSlash(cleanName))
		rel, err := filepath.Rel(tmpDir, targetPath)
		if err != nil || strings.HasPrefix(rel, "..") {
			return "", fmt.Errorf("path traversal detected: %s", hdr.Name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
				return "", err
			}
			outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode().Perm())
			if err != nil {
				return "", err
			}
			_, copyErr := io.Copy(outFile, tr)
			outFile.Close()
			if copyErr != nil {
				return "", copyErr
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(hdr.Linkname) {
				return "", fmt.Errorf("unsafe absolute symlink target: %s -> %s", hdr.Name, hdr.Linkname)
			}
			resolved := filepath.Clean(filepath.Join(filepath.Dir(targetPath), filepath.FromSlash(hdr.Linkname)))
			relCheck, err := filepath.Rel(tmpDir, resolved)
			if err != nil || strings.HasPrefix(relCheck, "..") {
				return "", fmt.Errorf("unsafe symlink escaping archive root: %s -> %s", hdr.Name, hdr.Linkname)
			}
			if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
				return "", err
			}
			_ = os.Symlink(hdr.Linkname, targetPath)
		}
	}

	if _, err := os.Stat(expandedDir); err == nil {
		_ = os.RemoveAll(expandedDir)
	}
	if err := os.Rename(tmpDir, expandedDir); err != nil {
		return "", fmt.Errorf("failed to move unpacked directory: %w", err)
	}
	success = true

	// Remove tarball after decompact to preserve single-state invariant (expanded xor compacted).
	_ = os.Remove(compactPath)

	expandedSize, _ := computeArchiveDirSize(expandedDir)
	metaStore := NewMetaStore(archiveRoot)
	now := time.Now().UnixMilli()
	_ = metaStore.Update(func(meta MetaStore) bool {
		key := archiveKey(owner, repo, sha)
		entry, ok := meta[key]
		if !ok {
			entry = ArchiveMeta{
				Owner:     owner,
				Repo:      repo,
				Sha:       sha,
				CreatedAt: now,
			}
		}
		entry.Size = expandedSize
		entry.Compacted = false
		entry.LastHitAt = now
		meta[key] = entry
		return true
	})
	_ = metaStore.Flush()

	return expandedDir, nil
}

func ReadSingleFileFromCompactArchive(compactPath, targetRelPath string, startLine, endLine, maxBytes int) (string, error) {
	if compactPath == "" || targetRelPath == "" {
		return "", errors.New("compactPath and targetRelPath must not be empty")
	}
	if strings.Contains(targetRelPath, "\x00") || strings.Contains(targetRelPath, "..") {
		return "", fmt.Errorf("unsafe or invalid targetRelPath: %s", targetRelPath)
	}

	normTarget := strings.ReplaceAll(targetRelPath, "\\", "/")
	targetClean := strings.Trim(filepath.ToSlash(filepath.Clean("/"+normTarget)), "/")
	if targetClean == "" || targetClean == "." || strings.Contains(targetClean, "..") {
		return "", fmt.Errorf("unsafe or invalid targetRelPath: %s", targetRelPath)
	}

	if maxBytes <= 0 {
		maxBytes = 2 * 1024 * 1024
	}

	f, err := os.Open(compactPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}

		cleanHdr := strings.Trim(filepath.ToSlash(filepath.Clean("/"+strings.ReplaceAll(hdr.Name, "\\", "/"))), "/")
		if cleanHdr != targetClean {
			continue
		}

		if maxBytes > 0 && hdr.Size > int64(maxBytes) {
			return "", fmt.Errorf("file %s (%d bytes) exceeds limit of %d bytes: %w", targetClean, hdr.Size, maxBytes, ErrFileTooLarge)
		}

		buf, err := io.ReadAll(io.LimitReader(tr, int64(maxBytes)+1))
		if err != nil && err != io.EOF {
			return "", err
		}
		if maxBytes > 0 && len(buf) > maxBytes {
			return "", fmt.Errorf("file %s exceeds limit of %d bytes: %w", targetClean, maxBytes, ErrFileTooLarge)
		}
		content := string(buf)

		if startLine > 0 {
			lines := strings.Split(content, "\n")
			totalLines := len(lines)
			if startLine > totalLines {
				return "", nil
			}
			clampedEnd := endLine
			if clampedEnd <= 0 || clampedEnd > totalLines {
				clampedEnd = totalLines
			}
			if clampedEnd < startLine {
				return "", nil
			}
			return strings.Join(lines[startLine-1:clampedEnd], "\n"), nil
		}

		return content, nil
	}

	return "", os.ErrNotExist
}
