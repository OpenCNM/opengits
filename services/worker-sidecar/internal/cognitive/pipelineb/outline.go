package pipelineb

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

// ── 严格解析（收敛闸门第一道）───────────────────────────────
// prompt 文本 SSOT = apps/client registry.ts 的 outline_map_v1/outline_plan_v1
// compile——Go 侧只传原始变量（RenderMap/RenderSkeleton 文本），零 prompt 拼装。

// rawChapterItem 支持字段别名容错的解析结构。
type rawChapterItem struct {
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary"`
	Description string   `json:"description"`
	Files       []string `json:"files"`
	Paths       []string `json:"paths"`
	Phase       string   `json:"phase"`
	PartTitle   string   `json:"partTitle"`
	ModuleTitle string   `json:"moduleTitle"`
}

// 解析上限（超出整章丢弃，全部无效则报错）。maxChapters=14 与网关 zod
// chapters.max(14) 及 deep 档 10~14 章带同步（schema 三态同步红线）。
const (
	maxChapters     = 14
	maxNameLen      = 120
	maxSummaryLen   = 400
	maxFilesPerChap = 40
	// maxPartTitleLen 与网关 outline_map_v1 zod partTitle.max(100) 三态同步。
	maxPartTitleLen = 100
)

// ParseOutlineJSON 严格解析 + 确定性剥壳 + 别名容错自愈 + 逐章校验：
// 1. 使用 pipeline.StripPayloadShell 剥除 markdown 围栏、思考块与外层容器；
// 2. 字段别名容错：chapters 为空时，依次回退探测 modules / tableOfContents / sections；
// 3. 超限条目与无效单章丢弃，全部无效则报错。
func validateAndAssembleOutline(items []rawChapterItem) ([]cognitive.OutlineChapter, error) {
	if len(items) == 0 {
		return nil, errors.New("zero chapters")
	}

	out := make([]cognitive.OutlineChapter, 0, len(items))
	for _, c := range items {
		name := strings.TrimSpace(c.Name)
		if name == "" {
			name = strings.TrimSpace(c.Title)
		}
		name = cognitive.CleanChapterTitle(name)
		summary := strings.TrimSpace(c.Summary)
		if summary == "" {
			summary = strings.TrimSpace(c.Description)
		}
		fileList := c.Files
		if len(fileList) == 0 {
			fileList = c.Paths
		}

		if name == "" || len([]rune(name)) > maxNameLen ||
			len([]rune(summary)) > maxSummaryLen || len(fileList) == 0 {
			continue // 单章无效丢弃，不毁整纲
		}
		if len(fileList) > maxFilesPerChap {
			fileList = fileList[:maxFilesPerChap]
		}
		files := make([]cognitive.ChapterFile, 0, len(fileList))
		for _, p := range fileList {
			p = strings.TrimSpace(p)
			if p != "" {
				files = append(files, cognitive.ChapterFile{Path: p})
			}
		}
		if len(files) == 0 {
			continue
		}
		partTitle := strings.TrimSpace(c.PartTitle)
		if partTitle == "" {
			partTitle = strings.TrimSpace(c.ModuleTitle)
		}
		if r := []rune(partTitle); len(r) > maxPartTitleLen {
			partTitle = string(r[:maxPartTitleLen])
		}
		out = append(out, cognitive.OutlineChapter{
			Name:      name,
			Summary:   summary,
			Files:     files,
			PartTitle: partTitle,
		})
		if len(out) >= maxChapters {
			break
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no valid chapter after validation")
	}
	return out, nil
}

// ParseOutlineJSON 严格解析 + 确定性剥壳 + 别名容错自愈 + 逐章校验：
// 1. 使用 pipeline.StripPayloadShell 剥除 markdown 围栏、思考块与外层容器；
// 2. 支持顶层 JSON 数组与顶层 JSON 对象；
// 3. 字段别名容错：chapters 为空时，依次回退探测 modules / tableOfContents / sections；
// 4. 超限条目与无效单章丢弃，全部无效则报错。
func ParseOutlineJSON(raw string) ([]cognitive.OutlineChapter, error) {
	clean, _ := pipeline.StripPayloadShell(raw)
	clean = strings.TrimSpace(clean)

	var items []rawChapterItem

	// 1. 若直接是合法 JSON 数组
	if strings.HasPrefix(clean, "[") && strings.HasSuffix(clean, "]") {
		if err := json.Unmarshal([]byte(clean), &items); err == nil && len(items) > 0 {
			return validateAndAssembleOutline(items)
		}
	}

	// 2. 探测外层容器（判断数组与对象先后顺序）
	arrayStart := strings.Index(clean, "[")
	arrayEnd := strings.LastIndex(clean, "]")
	braceStart := strings.Index(clean, "{")
	braceEnd := strings.LastIndex(clean, "}")

	// 优先 Case A: 数组先于对象出现，或仅有数组
	if arrayStart != -1 && (braceStart == -1 || arrayStart < braceStart) && arrayEnd > arrayStart {
		arrayStr := clean[arrayStart : arrayEnd+1]
		if err := json.Unmarshal([]byte(arrayStr), &items); err == nil && len(items) > 0 {
			return validateAndAssembleOutline(items)
		}
	}

	// 优先 Case B: 对象先于数组出现
	if braceStart >= 0 && braceEnd > braceStart {
		jsonStr := clean[braceStart : braceEnd+1]
		var rawMap map[string]json.RawMessage
		if err := json.Unmarshal([]byte(jsonStr), &rawMap); err == nil && len(rawMap) > 0 {
			aliasKeys := []string{"chapters", "modules", "tableOfContents", "sections"}
			containerKeys := []string{"data", "result", "plan", "output", "response"}

			var findChaptersInMap func(m map[string]json.RawMessage, depth int) json.RawMessage
			findChaptersInMap = func(m map[string]json.RawMessage, depth int) json.RawMessage {
				if depth > 4 || len(m) == 0 {
					return nil
				}
				for _, k := range aliasKeys {
					if val, ok := m[k]; ok && len(val) > 0 {
						return val
					}
				}
				for _, c := range containerKeys {
					subVal, ok := m[c]
					if !ok || len(subVal) == 0 {
						continue
					}
					var subMap map[string]json.RawMessage
					if err := json.Unmarshal(subVal, &subMap); err != nil {
						continue
					}
					if res := findChaptersInMap(subMap, depth+1); len(res) > 0 {
						return res
					}
				}
				return nil
			}

			rawChapters := findChaptersInMap(rawMap, 0)
			if len(rawChapters) > 0 && json.Unmarshal(rawChapters, &items) == nil && len(items) > 0 {
				return validateAndAssembleOutline(items)
			}
		}
	}

	// 3. 保底探测：整体 unmarshal
	if err := json.Unmarshal([]byte(clean), &items); err == nil && len(items) > 0 {
		return validateAndAssembleOutline(items)
	}

	if braceStart < 0 && arrayStart < 0 {
		return nil, errors.New("no JSON object in response")
	}

	return nil, errors.New("no valid chapter after validation")
}

// FilterChaptersByRepoMap 对照 RepoMap.Files 的物理路径集合过滤章节文件，去除模型编造的幻觉文件。
// 若章节所有文件均被剔除，则整章修剪。
func FilterChaptersByRepoMap(chapters []cognitive.OutlineChapter, m *RepoMap) ([]cognitive.OutlineChapter, []string) {
	if m == nil {
		return chapters, nil
	}
	realFiles := make(map[string]bool, len(m.Files))
	for _, f := range m.Files {
		realFiles[f.Path] = true
	}

	var filtered []cognitive.OutlineChapter
	var dropped []string

	for _, ch := range chapters {
		var keptFiles []cognitive.ChapterFile
		for _, f := range ch.Files {
			if realFiles[f.Path] {
				var keptCompanions []string
				for _, comp := range f.CompanionFiles {
					if realFiles[comp] {
						keptCompanions = append(keptCompanions, comp)
					}
				}
				f.CompanionFiles = keptCompanions
				keptFiles = append(keptFiles, f)
			} else {
				dropped = append(dropped, f.Path)
			}
		}
		if len(keptFiles) > 0 {
			ch.Files = keptFiles
			filtered = append(filtered, ch)
		}
	}
	return filtered, dropped
}

// ── 文件遍历（本地目录 → 内容文件清单）──────────────────────

type walkedFile struct {
	rel  string
	full string
	size int64
}

// readFileLimited 读文件（1MB 上限，防大文件爆内存）。
func readFileLimited(path string, limit int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, limit)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return "", err
	}
	return string(buf[:n]), nil
}

// walkContentFiles 遍历目录收集内容文件（跳过非内容目录/二进制/非文档非代码，支持卷前缀剪枝与 16 层深度硬截断）。
func walkContentFiles(root string, patterns cognitive.Patterns, prefixScope ...string) ([]walkedFile, error) {
	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	const maxDirectoryDepth = 16
	var out []walkedFile
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)

		if d.IsDir() {
			if p == root || rel == "." {
				return nil
			}
			// 深度截断：超过 16 层物理截断，防止递归软链接与超深目录死循环
			if strings.Count(rel, "/") >= maxDirectoryDepth {
				return filepath.SkipDir
			}
			name := d.Name()
			if name == ".git" || name == "node_modules" || patterns.IsNonContentDir(rel) {
				return filepath.SkipDir
			}
			// 卷前缀剪枝：若指定了卷作用域（如 "packages/core"），跳过无关兄弟目录（如 "packages/cli"）
			if scope != "" {
				if !strings.HasPrefix(scope+"/", rel+"/") && !strings.HasPrefix(rel+"/", scope+"/") {
					return filepath.SkipDir
				}
			}
			return nil
		}

		// 卷前缀过滤：若指定了卷作用域，只收集该卷下的文件
		if scope != "" && !strings.HasPrefix(rel+"/", scope+"/") {
			return nil
		}

		if patterns.IsBinaryOrArchiveFile(rel) || patterns.IsNonContentFile(rel) {
			return nil
		}
		if !patterns.IsCodeFile(rel) && !patterns.IsDocFile(rel) {
			return nil
		}
		var size int64
		if fi, err := d.Info(); err == nil {
			size = fi.Size()
		}
		out = append(out, walkedFile{rel: rel, full: p, size: size})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
