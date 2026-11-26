package treesitter

import (
	"context"
	"fmt"
	"strings"
)

type ControlFlowNode struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	StartByte int    `json:"startByte"`
	EndByte   int    `json:"endByte"`
}

const (
	goControlFlowScm = `[
  (function_declaration name: (identifier) @name) @function
  (method_declaration name: (field_identifier) @name) @function
  (if_statement) @branch
  (expression_switch_statement) @branch
  (type_switch_statement) @branch
  (for_statement) @loop
  (return_statement) @return
]`

	tsControlFlowScm = `[
  (function_declaration name: (identifier) @name) @function
  (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
  (method_definition name: (property_identifier) @name) @function
  (if_statement) @branch
  (switch_statement) @branch
  (for_statement) @loop
  (for_in_statement) @loop
  (while_statement) @loop
  (try_statement) @branch
  (return_statement) @return
  (throw_statement) @return
]`

	pyControlFlowScm = `[
  (function_definition name: (identifier) @name) @function
  (if_statement) @branch
  (for_statement) @loop
  (while_statement) @loop
  (try_statement) @branch
  (return_statement) @return
]`

	rustControlFlowScm = `[
  (function_item name: (identifier) @name) @function
  (if_expression) @branch
  (match_expression) @branch
  (for_expression) @loop
  (while_expression) @loop
  (loop_expression) @loop
  (return_expression) @return
]`
)

func getControlFlowScm(lang string) string {
	switch lang {
	case "go":
		return goControlFlowScm
	case "tsx", "typescript", "javascript":
		return tsControlFlowScm
	case "python":
		return pyControlFlowScm
	case "rust":
		return rustControlFlowScm
	default:
		return ""
	}
}

func (w *worker) ensureControlFlowQuery(lang string, langPtr uint64) (uint64, error) {
	key := lang + ":controlflow"
	if qPtr, ok := w.queries[key]; ok {
		return qPtr, nil
	}

	scm := getControlFlowScm(lang)
	if scm == "" {
		return 0, fmt.Errorf("no control flow query for %q", lang)
	}

	queryBytes := []byte(scm)
	qMem, err := w.malloc.Call(w.ctx, uint64(len(queryBytes)+1))
	if err != nil {
		return 0, err
	}
	defer w.free.Call(w.ctx, qMem[0])

	if werr := w.writeMem(uint32(qMem[0]), append(queryBytes, 0)); werr != nil {
		return 0, werr
	}

	errOffMem, _ := w.malloc.Call(w.ctx, 4)
	errTypeMem, _ := w.malloc.Call(w.ctx, 4)
	defer w.free.Call(w.ctx, errOffMem[0])
	defer w.free.Call(w.ctx, errTypeMem[0])

	res, err := w.queryNew.Call(w.ctx, langPtr, qMem[0], uint64(len(queryBytes)), errOffMem[0], errTypeMem[0])
	if err != nil {
		return 0, fmt.Errorf("failed to compile controlflow query for %q: %w", lang, err)
	}
	queryPtr := res[0]
	if queryPtr == 0 {
		return 0, fmt.Errorf("invalid controlflow query for %q", lang)
	}

	w.queries[key] = queryPtr
	return queryPtr, nil
}

func (e *Engine) ExtractControlFlow(ctx context.Context, lang string, source []byte) ([]ControlFlowNode, error) {
	if len(source) == 0 {
		return nil, nil
	}
	w, err := e.acquireWorker(ctx)
	if err != nil {
		return nil, err
	}
	defer e.releaseWorker(w)
	return w.extractControlFlow(ctx, lang, source)
}

func (w *worker) extractControlFlow(ctx context.Context, lang string, source []byte) ([]ControlFlowNode, error) {
	w.parseCount++
	canonicalLang := CanonicalLanguage(lang)
	langPtr, err := w.ensureLanguage(canonicalLang)
	if err != nil {
		return nil, err
	}

	queryPtr, err := w.ensureControlFlowQuery(canonicalLang, langPtr)
	if err != nil {

		return w.fallbackControlFlowFromExtract(ctx, canonicalLang, source)
	}

	setRes, err := w.parserSetLang.Call(w.ctx, w.parserPtr, langPtr)
	if err != nil || setRes[0] == 0 {
		return nil, fmt.Errorf("failed to set language on parser: %w", err)
	}

	codeMem, err := w.malloc.Call(w.ctx, uint64(len(source)+1))
	if err != nil {
		return nil, err
	}
	defer w.free.Call(w.ctx, codeMem[0])

	if werr := w.writeSourceNul(uint32(codeMem[0]), source); werr != nil {
		return nil, werr
	}

	pRes, err := w.parserParse.Call(w.ctx, w.parserPtr, 0, codeMem[0], uint64(len(source)))
	if err != nil || pRes[0] == 0 {
		return nil, fmt.Errorf("failed to parse string")
	}
	treePtr := pRes[0]
	defer w.free.Call(w.ctx, treePtr)

	if _, err := w.treeRootNode.Call(w.ctx, w.nodeMem, treePtr); err != nil {
		return nil, fmt.Errorf("failed to get root node: %w", err)
	}

	if _, err := w.cursorExec.Call(w.ctx, w.cursorPtr, queryPtr, w.nodeMem); err != nil {
		return nil, fmt.Errorf("failed to exec query cursor: %w", err)
	}

	lineIdx := newLineIndex(source)
	lenBufMem, _ := w.malloc.Call(w.ctx, 4)
	defer w.free.Call(w.ctx, lenBufMem[0])

	var nodes []ControlFlowNode
	seen := make(map[string]bool)

	for {
		mRes, err := w.cursorNext.Call(w.ctx, w.cursorPtr, w.matchMem)
		if err != nil {
			return nil, fmt.Errorf("query cursor next failed: %w", err)
		}
		if mRes[0] == 0 {
			break
		}

		matchBytes, ok := w.envMod.Memory().Read(uint32(w.matchMem), 12)
		if !ok {
			break
		}
		captureCount := uint16(matchBytes[6]) | (uint16(matchBytes[7]) << 8)
		capturesPtr := uint32(matchBytes[8]) | (uint32(matchBytes[9]) << 8) | (uint32(matchBytes[10]) << 16) | (uint32(matchBytes[11]) << 24)

		var capturedKind string
		var capturedName string
		var nodeStart, nodeEnd uint32

		for i := uint16(0); i < captureCount; i++ {
			capOffset := capturesPtr + uint32(i)*28
			capNodePtr := capOffset
			capIndexBytes, ok := w.envMod.Memory().Read(capOffset+24, 4)
			if !ok {
				continue
			}
			capIndex := uint32(capIndexBytes[0]) | (uint32(capIndexBytes[1]) << 8) | (uint32(capIndexBytes[2]) << 16) | (uint32(capIndexBytes[3]) << 24)

			capName := w.captureName(w.ctx, queryPtr, capIndex, lenBufMem[0])
			if capName == "" {
				continue
			}

			sbRes, err := w.nodeStartByte.Call(w.ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			ebRes, err := w.nodeEndByte.Call(w.ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			sb := uint32(sbRes[0])
			eb := uint32(ebRes[0])

			if capName == "name" {
				if int(eb) <= len(source) && sb <= eb {
					capturedName = string(source[sb:eb])
				}
			} else if capName == "function" || capName == "branch" || capName == "loop" || capName == "call" || capName == "return" {
				capturedKind = capName
				nodeStart = sb
				nodeEnd = eb
			}
		}

		if capturedKind == "" {
			continue
		}

		sLine, _ := lineIdx.getPosition(int(nodeStart))
		eLine, _ := lineIdx.getPosition(int(nodeEnd))

		key := fmt.Sprintf("%s:%d-%d:%s", capturedKind, nodeStart, nodeEnd, capturedName)
		if seen[key] {
			continue
		}
		seen[key] = true

		nodes = append(nodes, ControlFlowNode{
			Kind:      capturedKind,
			Name:      capturedName,
			StartLine: sLine,
			EndLine:   eLine,
			StartByte: int(nodeStart),
			EndByte:   int(nodeEnd),
		})
	}

	return nodes, nil
}

func CanonicalLanguage(lang string) string {
	l := strings.ToLower(strings.TrimSpace(lang))
	l = strings.TrimPrefix(l, ".")
	switch l {
	case "ts", "typescript", "mts", "cts":
		return "tsx"
	case "tsx":
		return "tsx"
	case "js", "javascript", "mjs", "cjs", "jsx":
		return "javascript"
	case "go", "golang":
		return "go"
	case "py", "python":
		return "python"
	case "rs", "rust":
		return "rust"
	case "java":
		return "java"
	case "c":
		return "c"
	case "cpp", "c++", "cc", "cxx":
		return "cpp"
	default:
		if detected := DetectLanguage("file." + l); detected != "" {
			return detected
		}
		return l
	}
}

func (w *worker) fallbackControlFlowFromExtract(ctx context.Context, lang string, source []byte) ([]ControlFlowNode, error) {
	res, err := w.parseAndExtract(ctx, lang, source)
	if err != nil {
		return nil, err
	}

	var nodes []ControlFlowNode
	for _, sym := range res.Symbols {
		nodes = append(nodes, ControlFlowNode{
			Kind:      "function",
			Name:      sym.Name,
			StartLine: sym.StartLine,
			EndLine:   sym.EndLine,
		})
	}
	return nodes, nil
}
