package llmstream

import (
	"bufio"
	"errors"
	"log"
	"strings"
)

// Caps SSE line buffering at 1MB so newline-free frames cannot OOM or reset watchdog; oversized lines drop fail-safe.
const maxUpstreamLineBytes = 1 << 20

// Emits frame-1 fail-fast alert on first oversized line and drains the remainder silently.
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
		if over {
			return "", err
		}
		return sb.String(), err
	}
}
