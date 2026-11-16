package treesitter

import (
	"bytes"
	"fmt"
	"io"
)

type wasmSection struct {
	id   byte
	data []byte
}

// PatchTsCore prepares ts_core.wasm to act as the Emscripten "env" host module:
// - Grows indirect function table min size to 2000
// - Grows memory min size to 512 pages (32MB)
// - Adds globals (__stack_pointer, __memory_base, __table_base)
// - Exports __indirect_function_table and the globals
func PatchTsCore(wasm []byte) ([]byte, error) {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	var sections []wasmSection
	for {
		id, err := r.ReadByte()
		if err != nil {
			break
		}
		l, err := readVarUint32(r)
		if err != nil {
			return nil, err
		}
		data := make([]byte, l)
		if _, err := io.ReadFull(r, data); err != nil {
			return nil, err
		}
		sections = append(sections, wasmSection{id: id, data: data})
	}

	// Patch Section 4 (Table)
	for i, sec := range sections {
		if sec.id == 4 {
			var tblBuf bytes.Buffer
			tblBuf.Write(encodeULEB128(1))
			tblBuf.WriteByte(0x70) // funcref
			tblBuf.WriteByte(0x00) // no maximum
			tblBuf.Write(encodeULEB128(2000))
			sections[i].data = tblBuf.Bytes()
		}
	}

	// Patch Section 5 (Memory)
	for i, sec := range sections {
		if sec.id == 5 {
			var memBuf bytes.Buffer
			memBuf.Write(encodeULEB128(1))
			memBuf.WriteByte(0x00)            // no maximum
			memBuf.Write(encodeULEB128(1536)) // 96MB
			sections[i].data = memBuf.Bytes()
		}
	}

	var existingGlobalCount uint32
	for i, sec := range sections {
		if sec.id == 6 {
			sr := bytes.NewReader(sec.data)
			existingGlobalCount, _ = readVarUint32(sr)
			remainder := make([]byte, sr.Len())
			sr.Read(remainder)

			var newGlobalSec bytes.Buffer
			newGlobalSec.Write(encodeULEB128(existingGlobalCount + 3))
			newGlobalSec.Write(remainder)

			// global +0: __stack_pointer (i32, mut 1, init 4MB = 4194304)
			newGlobalSec.WriteByte(0x7f)
			newGlobalSec.WriteByte(0x01)
			newGlobalSec.WriteByte(0x41)
			newGlobalSec.Write(encodeSLEB128(4194304))
			newGlobalSec.WriteByte(0x0b)

			// global +1: __memory_base (i32, const 0, init 2MB = 2097152)
			newGlobalSec.WriteByte(0x7f)
			newGlobalSec.WriteByte(0x00)
			newGlobalSec.WriteByte(0x41)
			newGlobalSec.Write(encodeSLEB128(2097152))
			newGlobalSec.WriteByte(0x0b)

			// global +2: __table_base (i32, const 0, init 100)
			newGlobalSec.WriteByte(0x7f)
			newGlobalSec.WriteByte(0x00)
			newGlobalSec.WriteByte(0x41)
			newGlobalSec.Write(encodeSLEB128(100))
			newGlobalSec.WriteByte(0x0b)

			sections[i].data = newGlobalSec.Bytes()
		}
	}

	for i, sec := range sections {
		if sec.id == 7 {
			sr := bytes.NewReader(sec.data)
			count, _ := readVarUint32(sr)
			var expBuf bytes.Buffer
			expBuf.Write(encodeULEB128(count + 4))
			io.Copy(&expBuf, sr)

			tblName := "__indirect_function_table"
			expBuf.Write(encodeULEB128(uint32(len(tblName))))
			expBuf.WriteString(tblName)
			expBuf.WriteByte(0x01) // table export
			expBuf.Write(encodeULEB128(0))

			gExports := []string{"__stack_pointer", "__memory_base", "__table_base"}
			for idxOffset, name := range gExports {
				expBuf.Write(encodeULEB128(uint32(len(name))))
				expBuf.WriteString(name)
				expBuf.WriteByte(0x03) // global export
				expBuf.Write(encodeULEB128(existingGlobalCount + uint32(idxOffset)))
			}

			sections[i].data = expBuf.Bytes()
		}
	}

	var out bytes.Buffer
	out.Write(header[:])
	for _, sec := range sections {
		out.WriteByte(sec.id)
		out.Write(encodeULEB128(uint32(len(sec.data))))
		out.Write(sec.data)
	}
	return out.Bytes(), nil
}

var libcFuncs = map[string]bool{
	"iswspace":  true,
	"iswalnum":  true,
	"iswalpha":  true,
	"isalpha":   true,
	"iswdigit":  true,
	"iswlower":  true,
	"iswupper":  true,
	"iswxdigit": true,
	"iswblank":  true, // moonbit 外部词法器空白判定（POSIX blank：空格/水平制表）
	"towupper":  true,
	"towlower":  true,
	"tolower":   true,
	"abort":     true,
	"memchr":    true,
	"memcmp":    true,
	"strncmp":   true,
	"memmove":   true,
	"memset":    true,
	"strcmp":    true,
	"strncpy":   true,
	// C++ 运行时（yaml 语法）：operator new/delete 转发 ts_core 分配器；
	// libc++ __throw_length_error（no-op 宿主实现）
	"_Znwm": true, "_ZdlPv": true,
	"_ZNKSt3__220__vector_base_commonILb1EE20__throw_length_errorEv": true,
}

func patchImportSection(data []byte, lang string) ([]byte, error) {
	sr := bytes.NewReader(data)
	numImports, err := readVarUint32(sr)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.Write(encodeULEB128(numImports))
	for i := uint32(0); i < numImports; i++ {
		modLen, err := readVarUint32(sr)
		if err != nil {
			return nil, err
		}
		modBytes := make([]byte, modLen)
		if _, err := io.ReadFull(sr, modBytes); err != nil {
			return nil, err
		}
		nameLen, err := readVarUint32(sr)
		if err != nil {
			return nil, err
		}
		nameBytes := make([]byte, nameLen)
		if _, err := io.ReadFull(sr, nameBytes); err != nil {
			return nil, err
		}
		kind, err := sr.ReadByte()
		if err != nil {
			return nil, err
		}

		modName := string(modBytes)
		funcName := string(nameBytes)

		if modName == "env" && libcFuncs[funcName] {
			modName = "libc"
		} else if modName == "GOT.func" || modName == "GOT.mem" {
			modName = "got." + lang
		} else if modName == "env" && (funcName == "__table_base" || funcName == "__memory_base") {
			modName = "got." + lang
		}

		out.Write(encodeULEB128(uint32(len(modName))))
		out.WriteString(modName)
		out.Write(encodeULEB128(uint32(len(funcName))))
		out.WriteString(funcName)
		out.WriteByte(kind)

		switch kind {
		case 0: // func
			tIdx, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			out.Write(encodeULEB128(tIdx))
		case 1: // table
			elemType, err := sr.ReadByte()
			if err != nil {
				return nil, err
			}
			flags, err := sr.ReadByte()
			if err != nil {
				return nil, err
			}
			min, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			out.WriteByte(elemType)
			out.WriteByte(flags)
			out.Write(encodeULEB128(min))
			if flags&1 != 0 {
				max, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				out.Write(encodeULEB128(max))
			}
		case 2: // mem
			flags, err := sr.ReadByte()
			if err != nil {
				return nil, err
			}
			min, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			out.WriteByte(flags)
			out.Write(encodeULEB128(min))
			if flags&1 != 0 {
				max, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				out.Write(encodeULEB128(max))
			}
		case 3: // global
			vType, err := sr.ReadByte()
			if err != nil {
				return nil, err
			}
			mut, err := sr.ReadByte()
			if err != nil {
				return nil, err
			}
			out.WriteByte(vType)
			out.WriteByte(mut)
		}
	}
	return out.Bytes(), nil
}

// prepareGrammar inspects a Tree-sitter side module WASM:
// - Detects if GOT.func, GOT.mem, or table/memory base imports exist
// - Rewrites standard C library function imports from "env" to "libc"
// - Redirects __table_base, __memory_base, GOT.func, and GOT.mem to an isolated "got.<lang>" module
// - Patches the Element section to place imported GOT functions into the indirect function table
// - Synthesizes the "got.<lang>" module exporting those globals with their resolved addresses
func prepareGrammar(rawWasm []byte, tableBase int32, memoryBase int32, lang string) (patchedWasm []byte, gotWasm []byte, err error) {
	imports, err := parseImports(rawWasm)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to parse grammar imports: %w", err)
	}

	var gotFuncs []string
	var gotMems []string
	var numImportedGlobals uint32
	hasTableBase := false
	hasMemoryBase := false

	for _, imp := range imports {
		if imp.Kind == 3 {
			numImportedGlobals++
		}
		if imp.Module == "GOT.func" {
			gotFuncs = append(gotFuncs, imp.Name)
		} else if imp.Module == "GOT.mem" {
			gotMems = append(gotMems, imp.Name)
		} else if imp.Module == "env" {
			if imp.Name == "__table_base" {
				hasTableBase = true
			} else if imp.Name == "__memory_base" {
				hasMemoryBase = true
			}
		}
	}

	var expGlobals map[string]uint32
	var definedOffsets []int32
	if len(gotMems) > 0 {
		expGlobals, err = parseExportedGlobals(rawWasm)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to parse grammar exported globals: %w", err)
		}
		definedOffsets, err = parseDefinedGlobalOffsets(rawWasm)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to parse grammar defined globals: %w", err)
		}
	}

	exports, err := parseExportedFunctions(rawWasm)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to parse grammar exports: %w", err)
	}

	var scannerFuncIndices []uint32
	for _, name := range gotFuncs {
		idx, found := exports[name]
		if !found {
			return nil, nil, fmt.Errorf("GOT.func symbol %q not found in grammar exports", name)
		}
		scannerFuncIndices = append(scannerFuncIndices, idx)
	}

	// Parse sections
	r := bytes.NewReader(rawWasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, nil, err
	}

	var sections []wasmSection
	var elemSecIdx = -1
	for {
		id, err := r.ReadByte()
		if err != nil {
			break
		}
		l, err := readVarUint32(r)
		if err != nil {
			return nil, nil, err
		}
		data := make([]byte, l)
		if _, err := io.ReadFull(r, data); err != nil {
			return nil, nil, err
		}
		if id == 2 {
			// Patch import section to rewrite "env" -> "libc" for standard C functions, and GOT.func -> got.<lang>
			data, err = patchImportSection(data, lang)
			if err != nil {
				return nil, nil, fmt.Errorf("failed to patch import section: %w", err)
			}
		} else if id == 9 {
			elemSecIdx = len(sections)
		}
		sections = append(sections, wasmSection{id: id, data: data})
	}

	var existingCount uint32
	if len(scannerFuncIndices) > 0 {
		if elemSecIdx >= 0 {
			sr := bytes.NewReader(sections[elemSecIdx].data)
			numSegs, _ := readVarUint32(sr)
			if numSegs == 1 {
				flags, _ := sr.ReadByte() // 0x00
				// offset expr: 0x23 <global_idx> 0x0b
				b1, _ := sr.ReadByte()
				globalIdx, _ := readVarUint32(sr)
				bEnd, _ := sr.ReadByte()

				existingCount, _ = readVarUint32(sr)
				var existingIndices []uint32
				for i := uint32(0); i < existingCount; i++ {
					fIdx, _ := readVarUint32(sr)
					existingIndices = append(existingIndices, fIdx)
				}

				// Reconstruct segment with appended scanner functions
				var newElemBuf bytes.Buffer
				newElemBuf.Write(encodeULEB128(1)) // 1 segment
				newElemBuf.WriteByte(flags)
				newElemBuf.WriteByte(b1)
				newElemBuf.Write(encodeULEB128(globalIdx))
				newElemBuf.WriteByte(bEnd)

				newCount := existingCount + uint32(len(scannerFuncIndices))
				newElemBuf.Write(encodeULEB128(newCount))
				for _, fIdx := range existingIndices {
					newElemBuf.Write(encodeULEB128(fIdx))
				}
				for _, fIdx := range scannerFuncIndices {
					newElemBuf.Write(encodeULEB128(fIdx))
				}
				sections[elemSecIdx].data = newElemBuf.Bytes()
			}
		} else {
			// If no element section existed, synthesize one with offset = global.get <table_base>
			var tableBaseGlobalIdx uint32
			var globalCounter uint32
			for _, imp := range imports {
				if imp.Kind != 3 {
					continue
				}
				if imp.Name == "__table_base" {
					tableBaseGlobalIdx = globalCounter
					break
				}
				globalCounter++
			}

			var newElemBuf bytes.Buffer
			newElemBuf.Write(encodeULEB128(1))
			newElemBuf.WriteByte(0x00) // active, table 0
			newElemBuf.WriteByte(0x23) // global.get
			newElemBuf.Write(encodeULEB128(tableBaseGlobalIdx))
			newElemBuf.WriteByte(0x0b) // end
			newElemBuf.Write(encodeULEB128(uint32(len(scannerFuncIndices))))
			for _, fIdx := range scannerFuncIndices {
				newElemBuf.Write(encodeULEB128(fIdx))
			}

			insertIdx := len(sections)
			for idx, sec := range sections {
				if sec.id >= 9 {
					insertIdx = idx
					break
				}
			}
			newSec := wasmSection{id: 9, data: newElemBuf.Bytes()}
			sections = append(sections[:insertIdx], append([]wasmSection{newSec}, sections[insertIdx:]...)...)
		}
	}

	var out bytes.Buffer
	out.Write(header[:])
	for _, sec := range sections {
		out.WriteByte(sec.id)
		out.Write(encodeULEB128(uint32(len(sec.data))))
		out.Write(sec.data)
	}
	patchedWasm = out.Bytes()

	// Build got.<lang> module if required
	type globalExp struct {
		name string
		mut  byte
		val  int32
	}
	var exportsList []globalExp
	for i, name := range gotFuncs {
		tblOffset := tableBase + int32(existingCount) + int32(i)
		exportsList = append(exportsList, globalExp{name: name, mut: 0x01, val: tblOffset})
	}
	for _, name := range gotMems {
		var offset int32
		if expGlobals != nil {
			if gIdx, ok := expGlobals[name]; ok && gIdx >= numImportedGlobals {
				relIdx := gIdx - numImportedGlobals
				if int(relIdx) < len(definedOffsets) {
					offset = definedOffsets[relIdx]
				}
			}
		}
		exportsList = append(exportsList, globalExp{name: name, mut: 0x01, val: memoryBase + offset})
	}
	if hasTableBase {
		exportsList = append(exportsList, globalExp{name: "__table_base", mut: 0x00, val: tableBase})
	}
	if hasMemoryBase {
		exportsList = append(exportsList, globalExp{name: "__memory_base", mut: 0x00, val: memoryBase})
	}

	if len(exportsList) == 0 {
		return patchedWasm, nil, nil
	}

	var gotBuf bytes.Buffer
	gotBuf.Write([]byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}) // header

	// Global section (id 6)
	var gSec bytes.Buffer
	gSec.Write(encodeULEB128(uint32(len(exportsList))))
	for _, ge := range exportsList {
		gSec.WriteByte(0x7f) // i32
		gSec.WriteByte(ge.mut)
		gSec.WriteByte(0x41) // i32.const
		gSec.Write(encodeSLEB128(ge.val))
		gSec.WriteByte(0x0b) // end
	}
	gotBuf.WriteByte(6)
	gotBuf.Write(encodeULEB128(uint32(gSec.Len())))
	gotBuf.Write(gSec.Bytes())

	// Export section (id 7)
	var eSec bytes.Buffer
	eSec.Write(encodeULEB128(uint32(len(exportsList))))
	for i, ge := range exportsList {
		eSec.Write(encodeULEB128(uint32(len(ge.name))))
		eSec.WriteString(ge.name)
		eSec.WriteByte(0x03) // global export
		eSec.Write(encodeULEB128(uint32(i)))
	}
	gotBuf.WriteByte(7)
	gotBuf.Write(encodeULEB128(uint32(eSec.Len())))
	gotBuf.Write(eSec.Bytes())

	gotWasm = gotBuf.Bytes()
	return patchedWasm, gotWasm, nil
}
