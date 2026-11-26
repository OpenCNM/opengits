package transcription

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExtractTailProse(t *testing.T) {
	t.Run("提取标准文档尾部Prose并剥离代码与Frontmatter", func(t *testing.T) {
		md := `---
title: Sample Doc
description: A test document
---

# 概述

这是一段开头的中文介绍文字。

` + "```typescript\nconst x = 100;\nconsole.log(x);\n```" + `

## 核心机制

中间段落讨论了核心架构实现，使用 [超链接](https://example.com) 和 <b>HTML加粗</b>。

` + "```go\nfunc Hello() string {\n    return \"world\"\n}\n```" + `

最后一段是课时小结。总结了本章节的关键收获与设计权衡，作为全文的自然语言结尾。`

		res := ExtractTailProse(md, 35)
		assert.Equal(t, "最后一段是课时小结。总结了本章节的关键收获与设计权衡，作为全文的自然语言结尾。", res.Prose)
		assert.Contains(t, res.RawSnippet, "最后一段是课时小结。")
		assert.False(t, strings.Contains(res.Prose, "func Hello"))
		assert.False(t, strings.Contains(res.Prose, "const x = 100"))
		assert.True(t, res.StartLine > 10)
	})

	t.Run("自底向上跨多段累加字符至满足阈值", func(t *testing.T) {
		md := `第一段：这是很前面的背景介绍。

第二段：这是稍微靠后的原理解释。

第三段：这是倒数第二段，讲述了实践中的常见坑点。

第四段：这是最终结论段落。`

		res := ExtractTailProse(md, 30)
		assert.Contains(t, res.Prose, "这是倒数第二段")
		assert.Contains(t, res.Prose, "这是最终结论段落")
		assert.NotContains(t, res.Prose, "第一段")
	})

	t.Run("纯代码文档提取为空", func(t *testing.T) {
		md := "```python\ndef run():\n    pass\n```"
		res := ExtractTailProse(md, 200)
		assert.Empty(t, res.Prose)
		assert.Empty(t, res.RawSnippet)
	})

	t.Run("空文档安全防御", func(t *testing.T) {
		res := ExtractTailProse("", 200)
		assert.Empty(t, res.Prose)
		assert.Equal(t, 0, res.TotalLines)
	})

	t.Run("净化标题和HTML与行内代码", func(t *testing.T) {
		line := "### 这是一个带 `code` 和 <span class=\"tag\">HTML</span> 与 [链接](url) 的行"
		cleaned := CleanProseLine(line)
		assert.Equal(t, "这是一个带 code 和 HTML 与 链接 的行", cleaned)
	})
}
