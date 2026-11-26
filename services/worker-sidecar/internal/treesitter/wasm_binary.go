package treesitter

import (
	"bytes"
	"io"
)

type WasmImport struct {
	Module string
	Name   string
	Kind   byte
}

func encodeSLEB128(val int32) []byte {
	var buf []byte
	for {
		b := byte(val & 0x7f)
		val >>= 7
		signBit := (b & 0x40) != 0
		if (val == 0 && !signBit) || (val == -1 && signBit) {
			buf = append(buf, b)
			break
		}
		buf = append(buf, b|0x80)
	}
	return buf
}

func encodeULEB128(val uint32) []byte {
	var buf []byte
	for {
		b := byte(val & 0x7f)
		val >>= 7
		if val != 0 {
			b |= 0x80
		}
		buf = append(buf, b)
		if val == 0 {
			break
		}
	}
	return buf
}

func readVarUint32(r io.ByteReader) (uint32, error) {
	var res uint32
	var shift uint
	for {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		res |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			break
		}
		shift += 7
	}
	return res, nil
}

func parseImports(wasm []byte) ([]WasmImport, error) {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	for {
		secID, err := r.ReadByte()
		if err != nil {
			break
		}
		secLen, err := readVarUint32(r)
		if err != nil {
			return nil, err
		}
		if secID == 2 {
			secData := make([]byte, secLen)
			if _, err := io.ReadFull(r, secData); err != nil {
				return nil, err
			}
			sr := bytes.NewReader(secData)
			numImports, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			var imports []WasmImport
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
				switch kind {
				case 0:
					if _, err := readVarUint32(sr); err != nil {
						return nil, err
					}
				case 1:
					if _, err := sr.ReadByte(); err != nil {
						return nil, err
					}
					flags, err := sr.ReadByte()
					if err != nil {
						return nil, err
					}
					if _, err := readVarUint32(sr); err != nil {
						return nil, err
					}
					if flags&1 != 0 {
						if _, err := readVarUint32(sr); err != nil {
							return nil, err
						}
					}
				case 2:
					flags, err := sr.ReadByte()
					if err != nil {
						return nil, err
					}
					if _, err := readVarUint32(sr); err != nil {
						return nil, err
					}
					if flags&1 != 0 {
						if _, err := readVarUint32(sr); err != nil {
							return nil, err
						}
					}
				case 3:
					if _, err := sr.ReadByte(); err != nil {
						return nil, err
					}
					if _, err := sr.ReadByte(); err != nil {
						return nil, err
					}
				}
				imports = append(imports, WasmImport{
					Module: string(modBytes),
					Name:   string(nameBytes),
					Kind:   kind,
				})
			}
			return imports, nil
		}
		if _, err := r.Seek(int64(secLen), io.SeekCurrent); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

func parseExportedFunctions(wasm []byte) (map[string]uint32, error) {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	exports := make(map[string]uint32)
	for {
		secID, err := r.ReadByte()
		if err != nil {
			break
		}
		secLen, err := readVarUint32(r)
		if err != nil {
			return nil, err
		}
		if secID == 7 {
			secData := make([]byte, secLen)
			if _, err := io.ReadFull(r, secData); err != nil {
				return nil, err
			}
			sr := bytes.NewReader(secData)
			cnt, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			for i := uint32(0); i < cnt; i++ {
				nl, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				nb := make([]byte, nl)
				if _, err := io.ReadFull(sr, nb); err != nil {
					return nil, err
				}
				kind, err := sr.ReadByte()
				if err != nil {
					return nil, err
				}
				idx, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				if kind == 0 {
					exports[string(nb)] = idx
				}
			}
			return exports, nil
		}
		if _, err := r.Seek(int64(secLen), io.SeekCurrent); err != nil {
			return nil, err
		}
	}
	return exports, nil
}

func decodeSLEB128(r io.ByteReader) (int32, error) {
	var res int32
	var shift uint
	for {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		res |= int32(b&0x7f) << shift
		shift += 7
		if b&0x80 == 0 {
			if shift < 32 && (b&0x40) != 0 {
				res |= -(int32(1) << shift)
			}
			break
		}
	}
	return res, nil
}

func ParseDataSectionSize(wasm []byte) uint32 {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0
	}
	for {
		secID, err := r.ReadByte()
		if err != nil {
			break
		}
		secLen, err := readVarUint32(r)
		if err != nil {
			break
		}
		if secID == 11 {
			return secLen
		}
		if _, err := r.Seek(int64(secLen), io.SeekCurrent); err != nil {
			break
		}
	}
	return 0
}

func parseExportedGlobals(wasm []byte) (map[string]uint32, error) {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	exports := make(map[string]uint32)
	for {
		secID, err := r.ReadByte()
		if err != nil {
			break
		}
		secLen, err := readVarUint32(r)
		if err != nil {
			return nil, err
		}
		if secID == 7 {
			secData := make([]byte, secLen)
			if _, err := io.ReadFull(r, secData); err != nil {
				return nil, err
			}
			sr := bytes.NewReader(secData)
			cnt, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			for i := uint32(0); i < cnt; i++ {
				nl, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				nb := make([]byte, nl)
				if _, err := io.ReadFull(sr, nb); err != nil {
					return nil, err
				}
				kind, err := sr.ReadByte()
				if err != nil {
					return nil, err
				}
				idx, err := readVarUint32(sr)
				if err != nil {
					return nil, err
				}
				if kind == 3 {
					exports[string(nb)] = idx
				}
			}
			return exports, nil
		}
		if _, err := r.Seek(int64(secLen), io.SeekCurrent); err != nil {
			return nil, err
		}
	}
	return exports, nil
}

func parseDefinedGlobalOffsets(wasm []byte) ([]int32, error) {
	r := bytes.NewReader(wasm)
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	for {
		secID, err := r.ReadByte()
		if err != nil {
			break
		}
		secLen, err := readVarUint32(r)
		if err != nil {
			return nil, err
		}
		if secID == 6 {
			secData := make([]byte, secLen)
			if _, err := io.ReadFull(r, secData); err != nil {
				return nil, err
			}
			sr := bytes.NewReader(secData)
			cnt, err := readVarUint32(sr)
			if err != nil {
				return nil, err
			}
			var offsets []int32
			for i := uint32(0); i < cnt; i++ {
				_, err := sr.ReadByte()
				if err != nil {
					return nil, err
				}
				_, err = sr.ReadByte()
				if err != nil {
					return nil, err
				}
				op, err := sr.ReadByte()
				if err != nil {
					return nil, err
				}
				var val int32
				if op == 0x41 {
					val, err = decodeSLEB128(sr)
					if err != nil {
						return nil, err
					}
				}
				for {
					b, err := sr.ReadByte()
					if err != nil {
						return nil, err
					}
					if b == 0x0b {
						break
					}
				}
				offsets = append(offsets, val)
			}
			return offsets, nil
		}
		if _, err := r.Seek(int64(secLen), io.SeekCurrent); err != nil {
			return nil, err
		}
	}
	return nil, nil
}
