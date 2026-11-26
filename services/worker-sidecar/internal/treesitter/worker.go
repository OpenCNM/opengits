package treesitter

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Owned by one borrowing goroutine at a time because Wazero WASM instances are single-threaded.
type worker struct {
	ctx           context.Context
	rt            wazero.Runtime
	envMod        api.Module
	malloc        api.Function
	free          api.Function
	parserNew     api.Function
	parserDel     api.Function
	parserSetLang api.Function
	parserParse   api.Function
	treeRootNode  api.Function
	nodeStartByte api.Function
	nodeEndByte   api.Function
	queryNew      api.Function
	cursorNew     api.Function
	cursorExec    api.Function
	cursorNext    api.Function
	capNameForID  api.Function
	nodeString    api.Function

	languages map[string]uint64
	queries   map[string]uint64

	// Cache immutable compiled query capture names per worker to avoid hot-loop WASM FFI calls.
	capNames       map[uint64]map[uint32]string
	parserPtr      uint64
	cursorPtr      uint64
	nodeMem        uint64
	matchMem       uint64
	nextTableBase  int32
	nextMemoryBase int32
	parseCount     int
}

const (
	DefaultMaxWorkerParses = 100

	DefaultMaxWorkerMemoryBytes = 64 * 1024 * 1024
)

// Fail fast on linear memory write bounds errors so parse never reads stale buffer contents.
func (w *worker) writeMem(ptr uint32, data []byte) error {
	if !w.envMod.Memory().Write(ptr, data) {
		return fmt.Errorf("wasm linear memory write failed at 0x%x (len=%d) — payload may exceed wasm memory bounds", ptr, len(data))
	}
	return nil
}

// Write source and NUL terminator separately to avoid copying or mutating the caller's slice backing array.
func (w *worker) writeSourceNul(ptr uint32, source []byte) error {
	if err := w.writeMem(ptr, source); err != nil {
		return err
	}
	return w.writeMem(ptr+uint32(len(source)), nulByte)
}

var nulByte = []byte{0}

func (w *worker) captureName(ctx context.Context, queryPtr uint64, capIndex uint32, lenBuf uint64) string {
	if byQuery, ok := w.capNames[queryPtr]; ok {
		if name, ok := byQuery[capIndex]; ok {
			return name
		}
	}
	namePtrRes, err := w.capNameForID.Call(ctx, queryPtr, uint64(capIndex), lenBuf)
	if err != nil {
		return ""
	}
	lenBytes, _ := w.envMod.Memory().Read(uint32(lenBuf), 4)
	nameLen := uint32(lenBytes[0]) | (uint32(lenBytes[1]) << 8) | (uint32(lenBytes[2]) << 16) | (uint32(lenBytes[3]) << 24)
	capNameBytes, _ := w.envMod.Memory().Read(uint32(namePtrRes[0]), nameLen)
	name := string(capNameBytes)
	byQuery, ok := w.capNames[queryPtr]
	if !ok {
		byQuery = make(map[uint32]string, 8)
		w.capNames[queryPtr] = byQuery
	}
	byQuery[capIndex] = name
	return name
}

func (w *worker) shouldRetire() bool {
	if w == nil {
		return false
	}
	if w.parseCount >= DefaultMaxWorkerParses {
		return true
	}
	if w.envMod != nil && w.envMod.Memory() != nil {
		if w.envMod.Memory().Size() >= uint32(DefaultMaxWorkerMemoryBytes) {
			return true
		}
	}
	return false
}

func newWorker(ctx context.Context, patchedCore []byte, compileCache wazero.CompilationCache) (*worker, error) {

	// Share CompilationCache across workers so retired instances re-instantiate without recompiling grammars.
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithCompilationCache(compileCache))

	wasi_snapshot_preview1.MustInstantiate(ctx, rt)

	compiledCore, err := rt.CompileModule(ctx, patchedCore)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to compile core wasm: %w", err)
	}

	envMod, err := rt.InstantiateModule(ctx, compiledCore, wazero.NewModuleConfig().WithName("env"))
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to instantiate env module: %w", err)
	}

	malloc := envMod.ExportedFunction("malloc")
	free := envMod.ExportedFunction("free")

	mallocFn := func(c context.Context, size uint64) (uint64, error) {
		res, err := malloc.Call(c, size)
		if err != nil || len(res) == 0 {
			return 0, err
		}
		return res[0], nil
	}
	freeFn := func(c context.Context, ptr uint64) error {
		_, err := free.Call(c, ptr)
		return err
	}
	if err := registerLibc(ctx, rt, &libcAllocator{malloc: mallocFn, free: freeFn}); err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to register libc host module: %w", err)
	}

	parserNew := envMod.ExportedFunction("ts_parser_new")
	parserDel := envMod.ExportedFunction("ts_parser_delete")
	parserSetLang := envMod.ExportedFunction("ts_parser_set_language")
	parserParse := envMod.ExportedFunction("ts_parser_parse_string")
	treeRootNode := envMod.ExportedFunction("ts_tree_root_node")
	nodeStartByte := envMod.ExportedFunction("ts_node_start_byte")
	nodeEndByte := envMod.ExportedFunction("ts_node_end_byte")
	queryNew := envMod.ExportedFunction("ts_query_new")
	cursorNew := envMod.ExportedFunction("ts_query_cursor_new")
	cursorExec := envMod.ExportedFunction("ts_query_cursor_exec")
	cursorNext := envMod.ExportedFunction("ts_query_cursor_next_match")
	capNameForID := envMod.ExportedFunction("ts_query_capture_name_for_id")
	nodeString := envMod.ExportedFunction("ts_node_string")

	if malloc == nil || free == nil || parserNew == nil || parserSetLang == nil || parserParse == nil ||
		treeRootNode == nil || nodeStartByte == nil || nodeEndByte == nil || queryNew == nil ||
		cursorNew == nil || cursorExec == nil || cursorNext == nil || capNameForID == nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("missing required Tree-sitter exports in ts_core.wasm")
	}

	pRes, err := parserNew.Call(ctx)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to create parser: %w", err)
	}
	parserPtr := pRes[0]

	cRes, err := cursorNew.Call(ctx)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to create query cursor: %w", err)
	}
	cursorPtr := cRes[0]

	nRes, err := malloc.Call(ctx, 32)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to allocate node memory: %w", err)
	}
	nodeMem := nRes[0]

	mRes, err := malloc.Call(ctx, 64)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("failed to allocate match memory: %w", err)
	}
	matchMem := mRes[0]

	return &worker{
		ctx:            ctx,
		rt:             rt,
		envMod:         envMod,
		malloc:         malloc,
		free:           free,
		parserNew:      parserNew,
		parserDel:      parserDel,
		parserSetLang:  parserSetLang,
		parserParse:    parserParse,
		treeRootNode:   treeRootNode,
		nodeStartByte:  nodeStartByte,
		nodeEndByte:    nodeEndByte,
		queryNew:       queryNew,
		cursorNew:      cursorNew,
		cursorExec:     cursorExec,
		cursorNext:     cursorNext,
		capNameForID:   capNameForID,
		nodeString:     nodeString,
		languages:      make(map[string]uint64),
		queries:        make(map[string]uint64),
		capNames:       make(map[uint64]map[uint32]string),
		parserPtr:      parserPtr,
		cursorPtr:      cursorPtr,
		nodeMem:        nodeMem,
		matchMem:       matchMem,
		nextTableBase:  100,
		nextMemoryBase: 8388608, // Reserve 0..8MB for ts_core execution stack and static data before placing grammar side-modules.
	}, nil
}

func (w *worker) close() error {
	if w.parserDel != nil && w.parserPtr != 0 {
		_, _ = w.parserDel.Call(w.ctx, w.parserPtr)
		w.parserPtr = 0
	}
	if w.nodeMem != 0 {
		_, _ = w.free.Call(w.ctx, w.nodeMem)
		w.nodeMem = 0
	}
	if w.matchMem != 0 {
		_, _ = w.free.Call(w.ctx, w.matchMem)
		w.matchMem = 0
	}
	if w.cursorPtr != 0 {
		_, _ = w.free.Call(w.ctx, w.cursorPtr)
		w.cursorPtr = 0
	}
	if w.rt != nil {
		return w.rt.Close(w.ctx)
	}
	return nil
}

func (w *worker) ensureLanguage(lang string) (uint64, error) {
	if lang == "typescript" {
		lang = "tsx"
	}
	if langPtr, ok := w.languages[lang]; ok {
		return langPtr, nil
	}

	rawGrammar, err := loadGrammarWasm(lang)
	if err != nil {
		return 0, err
	}

	tableBase := w.nextTableBase
	dataSize := ParseDataSectionSize(rawGrammar)
	if dataSize == 0 {
		dataSize = 1048576
	}
	alignedSize := int32((dataSize+65535)&^65535) + 65536
	memoryBase := w.nextMemoryBase
	w.nextMemoryBase += alignedSize

	patchedGrammar, gotWasm, err := prepareGrammar(rawGrammar, tableBase, memoryBase, lang)
	if err != nil {
		return 0, fmt.Errorf("failed to prepare grammar for %q: %w", lang, err)
	}

	if len(gotWasm) > 0 {
		cm, err := w.rt.CompileModule(w.ctx, gotWasm)
		if err != nil {
			return 0, fmt.Errorf("failed to compile got.%s: %w", lang, err)
		}
		gotModName := "got." + lang
		_, err = w.rt.InstantiateModule(w.ctx, cm, wazero.NewModuleConfig().WithName(gotModName))
		if err != nil {
			return 0, fmt.Errorf("failed to instantiate %s: %w", gotModName, err)
		}
	}

	cmGrammar, err := w.rt.CompileModule(w.ctx, patchedGrammar)
	if err != nil {
		return 0, fmt.Errorf("failed to compile grammar wasm for %q: %w", lang, err)
	}

	modGrammar, err := w.rt.InstantiateModule(w.ctx, cmGrammar, wazero.NewModuleConfig().WithName(lang))
	if err != nil {
		return 0, fmt.Errorf("failed to instantiate grammar %q: %w", lang, err)
	}

	if ctor := modGrammar.ExportedFunction("__wasm_call_ctors"); ctor != nil {
		if _, err := ctor.Call(w.ctx); err != nil {
			return 0, fmt.Errorf("failed calling __wasm_call_ctors for %q: %w", lang, err)
		}
	}
	if reloc := modGrammar.ExportedFunction("__wasm_apply_data_relocs"); reloc != nil {
		if _, err := reloc.Call(w.ctx); err != nil {
			return 0, fmt.Errorf("failed calling __wasm_apply_data_relocs for %q: %w", lang, err)
		}
	}

	cFnName, ok := LanguageToCFunction[lang]
	if !ok {
		cFnName = "tree_sitter_" + lang
	}
	fn := modGrammar.ExportedFunction(cFnName)
	if fn == nil {
		fn = modGrammar.ExportedFunction("tree_sitter_" + lang)
	}
	if fn == nil {
		return 0, fmt.Errorf("function %q not exported by grammar %q", cFnName, lang)
	}

	res, err := fn.Call(w.ctx)
	if err != nil {
		return 0, fmt.Errorf("calling %s failed: %w", cFnName, err)
	}
	langPtr := res[0]
	w.downgradeGrammarABI(langPtr)

	w.languages[lang] = langPtr
	w.nextTableBase += 50

	return langPtr, nil
}

func (w *worker) downgradeGrammarABI(langPtr uint64) {
	mem := w.envMod.Memory()
	ver, ok := mem.ReadUint32Le(uint32(langPtr))
	if !ok || ver <= 14 {
		return
	}
	stateCount, ok := mem.ReadUint32Le(uint32(langPtr) + 20)
	if !ok || stateCount == 0 {
		mem.WriteUint32Le(uint32(langPtr), 14)
		return
	}
	oldLexModesPtr, ok := mem.ReadUint32Le(uint32(langPtr) + 88)
	if !ok || oldLexModesPtr == 0 {
		mem.WriteUint32Le(uint32(langPtr), 14)
		return
	}
	newLexMem, err := w.malloc.Call(w.ctx, uint64(stateCount*4))
	if err == nil && len(newLexMem) > 0 && newLexMem[0] != 0 {
		newPtr := uint32(newLexMem[0])
		for i := uint32(0); i < stateCount; i++ {
			ls, _ := mem.ReadUint16Le(oldLexModesPtr + i*6)
			els, _ := mem.ReadUint16Le(oldLexModesPtr + i*6 + 2)
			mem.WriteUint16Le(newPtr+i*4, ls)
			mem.WriteUint16Le(newPtr+i*4+2, els)
		}
		mem.WriteUint32Le(uint32(langPtr)+88, newPtr)
	}
	mem.WriteUint32Le(uint32(langPtr), 14)
}

func (w *worker) ensureQuery(lang string, langPtr uint64) (uint64, error) {
	if lang == "typescript" {
		lang = "tsx"
	}
	if qPtr, ok := w.queries[lang]; ok {
		return qPtr, nil
	}

	queryBytes, err := loadQuery(lang)
	if err != nil {
		return 0, err
	}

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
		return 0, fmt.Errorf("failed to compile query for %q: %w", lang, err)
	}
	queryPtr := res[0]
	if queryPtr == 0 {
		offBytes, _ := w.envMod.Memory().Read(uint32(errOffMem[0]), 4)
		errOffset := uint32(offBytes[0]) | (uint32(offBytes[1]) << 8) | (uint32(offBytes[2]) << 16) | (uint32(offBytes[3]) << 24)
		return 0, fmt.Errorf("invalid query for %q at byte offset %d", lang, errOffset)
	}

	w.queries[lang] = queryPtr
	return queryPtr, nil
}

func (w *worker) debugAST(ctx context.Context, lang string, source []byte) (string, error) {
	w.parseCount++
	langPtr, err := w.ensureLanguage(lang)
	if err != nil {
		return "", err
	}
	setRes, err := w.parserSetLang.Call(ctx, w.parserPtr, langPtr)
	if err != nil || setRes[0] == 0 {
		return "", fmt.Errorf("failed to set language on parser: %w", err)
	}
	codeMem, err := w.malloc.Call(ctx, uint64(len(source)+1))
	if err != nil {
		return "", err
	}
	defer w.free.Call(ctx, codeMem[0])
	if werr := w.writeSourceNul(uint32(codeMem[0]), source); werr != nil {
		return "", werr
	}

	pRes, err := w.parserParse.Call(ctx, w.parserPtr, 0, codeMem[0], uint64(len(source)))
	if err != nil || pRes[0] == 0 {
		return "", fmt.Errorf("parse failed: %w", err)
	}
	treePtr := pRes[0]
	defer w.free.Call(ctx, treePtr)

	if _, err := w.treeRootNode.Call(ctx, w.nodeMem, treePtr); err != nil {
		return "", err
	}
	if w.nodeString == nil {
		return "", fmt.Errorf("ts_node_string not available")
	}
	strRes, err := w.nodeString.Call(ctx, w.nodeMem)
	if err != nil {
		return "", err
	}
	strPtr := uint32(strRes[0])
	if strPtr == 0 {
		return "", nil
	}
	defer w.free.Call(ctx, uint64(strPtr))

	var buf []byte
	const chunk = 4096
	for {
		seg, ok := w.envMod.Memory().Read(strPtr, chunk)
		if !ok || len(seg) == 0 {
			if !ok {

				memSize := w.envMod.Memory().Size()
				if rem := int(memSize - strPtr); rem > 0 {
					seg, ok = w.envMod.Memory().Read(strPtr, uint32(rem))
				}
				if !ok || len(seg) == 0 {
					break
				}
			} else {
				break
			}
		}
		if nul := bytes.IndexByte(seg, 0); nul >= 0 {
			buf = append(buf, seg[:nul]...)
			break
		}
		buf = append(buf, seg...)
		strPtr += uint32(len(seg))
		if uint32(len(seg)) < chunk {
			break
		}
	}
	return string(buf), nil
}

func (w *worker) parseAndExtract(ctx context.Context, lang string, source []byte) (*ExtractionResult, error) {
	w.parseCount++
	langPtr, err := w.ensureLanguage(lang)
	if err != nil {
		return nil, err
	}

	queryPtr, err := w.ensureQuery(lang, langPtr)
	if err != nil {
		return nil, err
	}

	setRes, err := w.parserSetLang.Call(ctx, w.parserPtr, langPtr)
	if err != nil || setRes[0] == 0 {
		return nil, fmt.Errorf("failed to set language on parser: %w", err)
	}

	codeMem, err := w.malloc.Call(ctx, uint64(len(source)+1))
	if err != nil {
		return nil, err
	}
	defer w.free.Call(ctx, codeMem[0])

	if werr := w.writeSourceNul(uint32(codeMem[0]), source); werr != nil {
		return nil, werr
	}

	pRes, err := w.parserParse.Call(ctx, w.parserPtr, 0, codeMem[0], uint64(len(source)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse string: %w", err)
	}
	treePtr := pRes[0]
	if treePtr == 0 {
		return nil, fmt.Errorf("parser returned null tree")
	}
	defer w.free.Call(ctx, treePtr)

	if _, err := w.treeRootNode.Call(ctx, w.nodeMem, treePtr); err != nil {
		return nil, fmt.Errorf("failed to get root node: %w", err)
	}

	if _, err := w.cursorExec.Call(ctx, w.cursorPtr, queryPtr, w.nodeMem); err != nil {
		return nil, fmt.Errorf("failed to execute query cursor: %w", err)
	}

	lineIdx := newLineIndex(source)
	var packageName string
	var symbols []SymbolMatch
	var callSites []CallMatch
	symbolIdxByNameLine := make(map[string]int)
	seenCalls := make(map[string]bool)

	type rawImport struct {
		module string
		start  uint32
		end    uint32
	}
	type rawBinding struct {
		name   string
		offset uint32
	}
	var rawImports []rawImport
	var rawBindings []rawBinding
	var rawBlankOffsets []uint32
	var rawDotOffsets []uint32

	lenBufMem, _ := w.malloc.Call(ctx, 4)
	defer w.free.Call(ctx, lenBufMem[0])

	for {
		mRes, err := w.cursorNext.Call(ctx, w.cursorPtr, w.matchMem)
		if err != nil {

			// Propagate cursor execution errors instead of treating WASM traps or OOM as end-of-matches.
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

		var defKind string
		var isMethod bool
		var defStart, defEnd uint32
		var symName string
		var isCall bool
		var isSelector bool
		var callQualifier string
		var callName string
		var callLine int
		var isImportStmt bool
		var stmtStart, stmtEnd uint32
		var importSource string
		var importStart, importEnd uint32
		var importBinding string
		var bindingOffset uint32
		var hasBlankImport bool
		var blankOffset uint32
		var hasDotImport bool
		var dotOffset uint32

		for i := uint16(0); i < captureCount; i++ {
			capOffset := capturesPtr + uint32(i)*28
			capNodePtr := capOffset
			capIndexBytes, ok := w.envMod.Memory().Read(capOffset+24, 4)
			if !ok {
				continue
			}
			capIndex := uint32(capIndexBytes[0]) | (uint32(capIndexBytes[1]) << 8) | (uint32(capIndexBytes[2]) << 16) | (uint32(capIndexBytes[3]) << 24)

			capName := w.captureName(ctx, queryPtr, capIndex, lenBufMem[0])
			if capName == "" {
				continue
			}

			sbRes, err := w.nodeStartByte.Call(ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			ebRes, err := w.nodeEndByte.Call(ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			sb := uint32(sbRes[0])
			eb := uint32(ebRes[0])

			if capName == "package.name" {
				if packageName == "" && int(eb) <= len(source) && sb <= eb {
					packageName = strings.TrimSpace(string(source[sb:eb]))
				}
			} else if strings.HasPrefix(capName, "definition.") {
				sub := strings.TrimPrefix(capName, "definition.")
				if sub == "function" || sub == "method" {
					defKind = "function"
					if sub == "method" {
						isMethod = true
					}
				} else {
					defKind = "type"
				}
				defStart = sb
				defEnd = eb
			} else if capName == "reference.call" {
				isCall = true
			} else if capName == "call.operand" {
				isSelector = true
				if int(eb) <= len(source) && sb <= eb {
					op := strings.TrimSpace(string(source[sb:eb]))
					if isSimpleASTIdentifier(op) {
						callQualifier = op
					}
				}
			} else if capName == "import" || capName == "import.statement" {
				isImportStmt = true
				stmtStart = sb
				stmtEnd = eb
			} else if capName == "import.source" {
				if int(eb) <= len(source) && sb <= eb {
					mod := strings.TrimSpace(string(source[sb:eb]))
					mod = strings.Trim(mod, `"'`+"`")
					if mod != "" {
						importSource = mod
						importStart = sb
						importEnd = eb
					}
				}
			} else if capName == "import.binding" {
				if int(eb) <= len(source) && sb <= eb {
					bName := strings.TrimSpace(string(source[sb:eb]))
					if bName != "" {
						importBinding = bName
						bindingOffset = sb
					}
				}
			} else if capName == "import.blank" {
				hasBlankImport = true
				blankOffset = sb
			} else if capName == "import.dot" {
				hasDotImport = true
				dotOffset = sb
			} else if capName == "name" || strings.HasSuffix(capName, ".name") {
				if int(eb) <= len(source) && sb <= eb {
					txt := string(source[sb:eb])
					if isCall {
						callName = txt
						callLine, _ = lineIdx.getPosition(int(sb))
					} else {
						symName = txt
					}
				}
			}
		}

		if isCall && callName != "" {
			key := fmt.Sprintf("%s@%d@%s@%t", callName, callLine, callQualifier, isSelector)
			if !seenCalls[key] {
				seenCalls[key] = true
				callSites = append(callSites, CallMatch{
					Name:       callName,
					Line:       callLine,
					Qualifier:  callQualifier,
					IsSelector: isSelector,
				})
			}
		}

		if importSource != "" {
			sStart := importStart
			sEnd := importEnd
			if isImportStmt && stmtEnd > stmtStart {
				sStart = stmtStart
				sEnd = stmtEnd
			}
			rawImports = append(rawImports, rawImport{
				module: importSource,
				start:  sStart,
				end:    sEnd,
			})
		}

		if importBinding != "" {
			rawBindings = append(rawBindings, rawBinding{
				name:   importBinding,
				offset: bindingOffset,
			})
		}
		if hasBlankImport {
			rawBlankOffsets = append(rawBlankOffsets, blankOffset)
		}
		if hasDotImport {
			rawDotOffsets = append(rawDotOffsets, dotOffset)
		}

		if defKind != "" {
			if symName == "" && defEnd > defStart && int(defEnd) <= len(source) {

				firstLine := strings.Split(string(source[defStart:defEnd]), "\n")[0]
				fields := strings.Fields(firstLine)
				if len(fields) > 1 {
					symName = fields[1]
				}
			}

			if symName != "" {
				startLine, startCol := lineIdx.getPosition(int(defStart))
				endByte := int(defEnd)
				if endByte > int(defStart) && endByte <= len(source) && source[endByte-1] == '\n' {
					endByte--
				}
				endLine, endCol := lineIdx.getPosition(endByte)

				lineKey := fmt.Sprintf("%s@%d", symName, startLine)
				if idx, exists := symbolIdxByNameLine[lineKey]; exists {
					if symbols[idx].Kind != "function" && defKind == "function" {
						symbols[idx].Kind = "function"
					}
					if isMethod {
						symbols[idx].IsMethod = true
					}
				} else {
					symbolIdxByNameLine[lineKey] = len(symbols)
					symbols = append(symbols, SymbolMatch{
						Name:      symName,
						Kind:      defKind,
						StartLine: startLine,
						EndLine:   endLine,
						StartCol:  startCol,
						EndCol:    endCol,
						IsMethod:  isMethod,
					})
				}
			}
		}
	}

	importMap := make(map[string]*ImportMatch)
	var importsOrder []string
	hasBlankSpec := make(map[string]bool)
	hasNonBlankSpec := make(map[string]bool)

	containsOffset := func(offsets []uint32, start, end uint32) bool {
		for _, off := range offsets {
			if off >= start && off <= end {
				return true
			}
		}
		return false
	}

	for _, imp := range rawImports {
		if _, exists := importMap[imp.module]; !exists {
			importMap[imp.module] = &ImportMatch{
				Module:   imp.module,
				Bindings: []string{},
			}
			importsOrder = append(importsOrder, imp.module)
		}
		if containsOffset(rawBlankOffsets, imp.start, imp.end) {
			hasBlankSpec[imp.module] = true
		} else {
			hasNonBlankSpec[imp.module] = true
		}
		if containsOffset(rawDotOffsets, imp.start, imp.end) {
			importMap[imp.module].Dot = true
		}
	}
	for mod, match := range importMap {
		if hasBlankSpec[mod] && !hasNonBlankSpec[mod] {
			match.Blank = true
		}
	}
	for _, b := range rawBindings {
		for _, imp := range rawImports {
			if b.offset >= imp.start && b.offset <= imp.end {
				if match := importMap[imp.module]; match != nil {
					hasB := false
					for _, existing := range match.Bindings {
						if existing == b.name {
							hasB = true
							break
						}
					}
					if !hasB {
						match.Bindings = append(match.Bindings, b.name)
					}
				}
				break
			}
		}
	}
	var finalImports []ImportMatch
	for _, mod := range importsOrder {
		if match := importMap[mod]; match != nil {
			finalImports = append(finalImports, *match)
		}
	}

	return &ExtractionResult{
		PackageName: packageName,
		Symbols:     symbols,
		CallSites:   callSites,
		Imports:     finalImports,
	}, nil
}

func isSimpleASTIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlpha := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
		isNum := c >= '0' && c <= '9'
		if i == 0 && !isAlpha {
			return false
		}
		if !isAlpha && !isNum {
			return false
		}
	}
	return true
}

type lineIndex struct {
	lineStarts []int
}

func newLineIndex(content []byte) *lineIndex {
	starts := []int{0}
	for i, b := range content {
		if b == '\n' {
			starts = append(starts, i+1)
		}
	}
	return &lineIndex{lineStarts: starts}
}

func (idx *lineIndex) getPosition(offset int) (line int, col int) {
	if offset < 0 {
		return 1, 0
	}
	i := sort.Search(len(idx.lineStarts), func(i int) bool {
		return idx.lineStarts[i] > offset
	}) - 1
	if i < 0 {
		i = 0
	}
	line = i + 1
	col = offset - idx.lineStarts[i]
	return line, col
}
