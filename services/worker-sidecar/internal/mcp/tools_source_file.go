package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
)

type readSourceFileArgs struct {
	Path      *string `json:"path"`
	StartLine *int    `json:"start_line"`
	EndLine   *int    `json:"end_line"`
}

const sourceFileMaxChars = 16000

const maxSourceFileReadBytes = 2 * 1024 * 1024

func cleanSourcePathRaw(rawPath string) (string, bool) {
	clean := strings.TrimSpace(strings.TrimPrefix(rawPath, "./"))
	if clean == "" || strings.Contains(clean, "..") || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "\\") {
		return "", false
	}
	return clean, true
}

func readRawSourceFile(archiveRoot, owner, repo, ref, relPath string) string {
	if archiveRoot == "" || owner == "" || repo == "" || ref == "" || relPath == "" {
		return ""
	}
	base := filepath.Join(archiveRoot, owner, repo, ref)
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		lowerBase := archive.ArchiveDirFor(archiveRoot, owner, repo, ref)
		if st2, err2 := os.Stat(lowerBase); err2 == nil && st2.IsDir() {
			base = lowerBase
		} else {
			compactPath := archive.CompactArchivePathFor(archiveRoot, owner, repo, ref)
			if cst, cerr := os.Stat(compactPath); cerr == nil && !cst.IsDir() {
				content, err := archive.ReadSingleFileFromCompactArchive(compactPath, relPath, 0, 0, maxSourceFileReadBytes)
				if err == nil {
					return content
				}
				return ""
			}
		}
	}
	full := filepath.Join(base, filepath.FromSlash(relPath))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	f, err := os.Open(full)
	if err != nil {
		return ""
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() || st.Size() > maxSourceFileReadBytes {
		return ""
	}

	b, err := io.ReadAll(io.LimitReader(f, maxSourceFileReadBytes+1))
	if err != nil || int64(len(b)) > maxSourceFileReadBytes {
		return ""
	}
	return string(b)
}

func (s *readService) runReadSourceFile(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args readSourceFileArgs) readResult {
	startTime := time.Now()
	repo := resolved.Repository

	rawPath := strings.TrimSpace(deref(args.Path))
	if rawPath == "" {
		return readResult{
			Text:    `Error: "path" is required. Pass a repository-relative file path (e.g. "internal/search/store_chunks.go"). Use outline or read_symbol to locate files first.`,
			IsError: true,
		}
	}
	cleanPath, ok := cleanSourcePathRaw(rawPath)
	if !ok {
		return readResult{
			Text:    fmt.Sprintf("Error: Invalid or unsafe file path: %s", rawPath),
			IsError: true,
		}
	}

	startLine, endLine := 0, 0
	if args.StartLine != nil && *args.StartLine > 0 {
		startLine = *args.StartLine
	}
	if args.EndLine != nil && *args.EndLine > 0 {
		endLine = *args.EndLine
	}
	if startLine > 0 && endLine > 0 && endLine < startLine {
		return readResult{
			Text:    fmt.Sprintf("Error: end_line (%d) must be >= start_line (%d).", endLine, startLine),
			IsError: true,
		}
	}

	sha := ""
	if s.store != nil {
		if _, _, sSha, ok := s.store.GetRepoGitSha(ctx, repo.ID); ok && sSha != "" {
			sha = sSha
		}
	}
	if sha == "" && len(repo.RepoProfile) > 0 {
		var prof map[string]any
		if err := json.Unmarshal(repo.RepoProfile, &prof); err == nil {
			if sVal, ok := prof["gitSha"].(string); ok && sVal != "" {
				sha = sVal
			}
		}
	}
	if sha == "" {
		sha = repo.Branch
	}

	archiveRoot := resolveArchiveRoot()

	content := ""
	usedRef := ""
	for _, ref := range []string{sha, repo.Branch} {
		if ref == "" {
			continue
		}
		if raw := readRawSourceFile(archiveRoot, repo.Owner, repo.Repo, ref, cleanPath); raw != "" {
			content, usedRef = raw, ref
			break
		}
	}
	if content == "" {
		for _, ref := range []string{sha, repo.Branch} {
			if ref == "" {
				continue
			}
			if raw := fetchImmutableSourceFile(ctx, archiveRoot, repo.Owner, repo.Repo, ref, cleanPath); raw != "" {
				content, usedRef = raw, ref
				break
			}
		}
	}
	if content == "" {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "read_source_file", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "source", Status: "BLIND_SPOT", ResultCount: 0, ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{
			Text: fmt.Sprintf(
				"File not found in local source archive: %s (tried ref: %s). The archive for this repository may be evicted; use read_symbol for symbol-level slices or check the exact path via outline.",
				cleanPath, strings.Join(nonEmptyStrings(sha, repo.Branch), ", ")),
			IsError: true,
		}
	}

	lines := strings.Split(content, "\n")
	totalLines := len(lines)
	body := content
	rangeInfo := ""
	if startLine > 0 {
		if startLine > totalLines {
			return readResult{
				Text:    fmt.Sprintf("Error: start_line (%d) exceeds file length (%d lines): %s", startLine, totalLines, cleanPath),
				IsError: true,
			}
		}
		clampedEnd := endLine
		if clampedEnd == 0 || clampedEnd > totalLines {
			clampedEnd = totalLines
		}
		body = strings.Join(lines[startLine-1:clampedEnd], "\n")
		rangeInfo = fmt.Sprintf(" (Lines %d–%d of %d)", startLine, clampedEnd, totalLines)
	}

	if len(body) > sourceFileMaxChars {
		body = body[:sourceFileMaxChars] + "\n… [Truncated for context limit]"
	}

	lang := detectSourceLanguage(cleanPath)
	var b strings.Builder
	fmt.Fprintf(&b, "# 📄 Source File: `%s`%s [%s]\n\n", cleanPath, rangeInfo, usedRef)
	fmt.Fprintf(&b, "```%s\n%s\n```\n", lang, body)
	if startLine == 0 && totalLines > 400 {
		b.WriteString("\n*(Long file: output capped. Pass start_line/end_line for a targeted window.)*")
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "read_source_file", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "source", Status: "SUCCESS", ResultCount: 1, ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}

func (s *readService) runHubReadSourceFile(ctx context.Context, userID, clientName, repoRef string, args readSourceFileArgs) readResult {
	cleanRef := strings.TrimSpace(repoRef)
	if cleanRef == "" {
		return readResult{
			Text:    `On OpenGits Hub mode, pass "repository" (e.g. "owner/repo" or from list_resources) to specify the target codebase for source file reading.`,
			IsError: true,
		}
	}

	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, cleanRef, "")
	if err != nil || resolved == nil {
		return hubRefNotFoundError(cleanRef)
	}

	if !resolved.Repository.IsPublic {
		allowed, err := s.store.HasSavedRepoAccess(ctx, resolved.Repository.ID, userID)
		if err != nil || !allowed {
			return readResult{
				Text:    fmt.Sprintf(`Forbidden: Repository %q is private.`, cleanRef),
				IsError: true,
			}
		}
	}

	return s.runReadSourceFile(ctx, resolved, userID, clientName, args)
}

func nonEmptyStrings(vals ...string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
