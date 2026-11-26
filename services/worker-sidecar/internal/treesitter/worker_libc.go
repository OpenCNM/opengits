package treesitter

import (
	"bytes"
	"context"
	"unicode"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

type libcAllocator struct {
	malloc func(ctx context.Context, size uint64) (uint64, error)
	free   func(ctx context.Context, ptr uint64) error
}

func registerLibc(ctx context.Context, rt wazero.Runtime, alloc *libcAllocator) error {
	b := rt.NewHostModuleBuilder("libc")
	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsSpace(r) {
			return 1
		}
		return 0
	}).Export("iswspace")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return 1
		}
		return 0
	}).Export("iswalnum")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsLetter(r) {
			return 1
		}
		return 0
	}).Export("iswalpha")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') {
			return 1
		}
		return 0
	}).Export("isalpha")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsDigit(r) {
			return 1
		}
		return 0
	}).Export("iswdigit")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsLower(r) {
			return 1
		}
		return 0
	}).Export("iswlower")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if unicode.IsUpper(r) {
			return 1
		}
		return 0
	}).Export("iswupper")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		r := rune(ch)
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			return 1
		}
		return 0
	}).Export("iswxdigit")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		if ch == ' ' || ch == '\t' {
			return 1
		}
		return 0
	}).Export("iswblank")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		return int32(unicode.ToUpper(rune(ch)))
	}).Export("towupper")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		return int32(unicode.ToLower(rune(ch)))
	}).Export("towlower")

	b.NewFunctionBuilder().WithFunc(func(ch int32) int32 {
		c := byte(ch)
		if c >= 'A' && c <= 'Z' {
			return int32(c + ('a' - 'A'))
		}
		return ch
	}).Export("tolower")

	// Forward C++ new/delete to ts_core allocator and no-op length_error trap for C++-backed grammars (e.g. yaml).
	if alloc != nil {
		b.NewFunctionBuilder().WithFunc(func(ctx context.Context, size uint32) uint32 {
			ptr, err := alloc.malloc(ctx, uint64(size))
			if err != nil || ptr == 0 {
				return 0
			}
			return uint32(ptr)
		}).Export("_Znwm")
		b.NewFunctionBuilder().WithFunc(func(ctx context.Context, ptr uint32) {
			_ = alloc.free(ctx, uint64(ptr))
		}).Export("_ZdlPv")

		b.NewFunctionBuilder().WithFunc(func(uint32) {}).Export("_ZNKSt3__220__vector_base_commonILb1EE20__throw_length_errorEv")
	}

	b.NewFunctionBuilder().WithFunc(func() {}).Export("abort")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, ptr uint32, ch int32, n uint32) uint32 {
		mem := mod.Memory()
		if mem == nil {
			return 0
		}
		buf, ok := mem.Read(ptr, n)
		if !ok {
			return 0
		}
		idx := bytes.IndexByte(buf, byte(ch))
		if idx < 0 {
			return 0
		}
		return ptr + uint32(idx)
	}).Export("memchr")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, p1, p2, n uint32) int32 {
		mem := mod.Memory()
		if mem == nil {
			return 0
		}
		b1, _ := mem.Read(p1, n)
		b2, _ := mem.Read(p2, n)
		return int32(bytes.Compare(b1, b2))
	}).Export("memcmp")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, s1, s2, n uint32) int32 {
		mem := mod.Memory()
		if mem == nil {
			return 0
		}
		b1, _ := mem.Read(s1, n)
		b2, _ := mem.Read(s2, n)
		for i := 0; i < len(b1) && i < len(b2); i++ {
			if b1[i] != b2[i] {
				return int32(b1[i]) - int32(b2[i])
			}
		}
		return 0
	}).Export("strncmp")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, dst, src, n uint32) uint32 {
		mem := mod.Memory()
		if mem == nil {
			return dst
		}
		b, ok := mem.Read(src, n)
		if !ok {
			return dst
		}
		tmp := make([]byte, len(b))
		copy(tmp, b)
		mem.Write(dst, tmp)
		return dst
	}).Export("memmove")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, ptr uint32, val int32, n uint32) uint32 {
		mem := mod.Memory()
		if mem == nil {
			return ptr
		}
		tmp := make([]byte, n)
		for i := range tmp {
			tmp[i] = byte(val)
		}
		mem.Write(ptr, tmp)
		return ptr
	}).Export("memset")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, s1, s2 uint32) int32 {
		mem := mod.Memory()
		if mem == nil {
			return 0
		}
		for {
			b1, ok1 := mem.ReadByte(s1)
			b2, ok2 := mem.ReadByte(s2)
			if !ok1 || !ok2 || b1 != b2 || b1 == 0 {
				return int32(b1) - int32(b2)
			}
			s1++
			s2++
		}
	}).Export("strcmp")

	b.NewFunctionBuilder().WithFunc(func(ctx context.Context, mod api.Module, dst, src, n uint32) uint32 {
		mem := mod.Memory()
		if mem == nil {
			return dst
		}
		for i := uint32(0); i < n; i++ {
			b, ok := mem.ReadByte(src + i)
			if !ok {
				break
			}
			mem.WriteByte(dst+i, b)
			if b == 0 {
				for j := i + 1; j < n; j++ {
					mem.WriteByte(dst+j, 0)
				}
				break
			}
		}
		return dst
	}).Export("strncpy")

	_, err := b.Instantiate(ctx)
	return err
}
