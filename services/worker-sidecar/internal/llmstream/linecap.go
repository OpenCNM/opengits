package llmstream

import (
	"bufio"
	"errors"
	"log"
	"strings"
)

// maxUpstreamLineBytes 单行 SSE 字节上限：ReadString 对无换行输入无限
// 累积，异常/恶意 BYOK provider 可借此无限拉高内存且每段数据重置
// watchdog（45s 活性超时永不触发）。1MB 远超任何合法增量帧（delta/
// usage/tool-call 均为 KB 级）。超限行整行丢弃——SSE 以行分隔，超限
// data 行不可能是合法帧，丢弃即 fail-safe。
const maxUpstreamLineBytes = 1 << 20

// readCappedLine 读取一行（对齐 bufio.Reader.ReadString 语义：返回内容
// 含 '\n'；EOF 时返回已累积部分 + io.EOF）。行长超过 maxBytes 时丢弃
// 整行返回空串——首帧越限即告警（frame-1 fail-fast），后续残余静默排空。
func readCappedLine(r *bufio.Reader, maxBytes int, callID string) (string, error) {
	var sb strings.Builder
	over := false
	for {
		chunk, err := r.ReadSlice('\n')
		if !over {
			if sb.Len()+len(chunk) > maxBytes {
				over = true
				log.Printf(
					"[llm-stream] STREAM_LINE_OVERSIZED: dropping line >%d bytes, call=%s (frame-1 fail-fast)",
					maxBytes, callID,
				)
				sb.Reset()
			} else {
				sb.Write(chunk)
			}
		}
		if err == nil {
			if over {
				return "", nil
			}
			return sb.String(), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		// EOF 或读错误：未超限时对齐 ReadString——把已累积部分交还调用方
		if over {
			return "", err
		}
		return sb.String(), err
	}
}
