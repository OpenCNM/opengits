const RESPONSE_FIELD_PATTERN = /^\s*(?:```(?:json)?\s*)?\{\s*"response"\s*:\s*"/;

/**
 * 增量解包历史或流式期间模型误包装的 `{"response": "..."}` JSON 外壳：
 * - 若文本非 `{"response": "...` 结构，直接原样返回；
 * - 若处于流式输出中（尚未闭合引号/花括号），按 JSON 字符串转义规则实时解码已到达字符，
 *   并在末尾遇到半截转义序列（如 `\` 或 `\u12`）时暂停到下一 token 到达。
 */
export function extractStreamableAssistantText(raw: string): string {
  if (!raw) return raw;

  const trimmedStart = raw.trimStart();
  if (!trimmedStart.startsWith('{') && !trimmedStart.startsWith('```')) {
    return raw;
  }

  const headerMatch = raw.match(RESPONSE_FIELD_PATTERN);
  if (!headerMatch) {
    return raw;
  }

  let i = headerMatch[0].length;
  let out = '';

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      // 完整 JSON 字符串闭合；后续仅应为 `}` / 代码块闭合标记，停止输出
      break;
    }

    if (ch === '\\') {
      if (i + 1 >= raw.length) {
        // 半截转义符位于流末尾，等待后续字符再解码
        break;
      }
      const next = raw[i + 1];
      switch (next) {
        case 'n':
          out += '\n';
          i += 2;
          break;
        case 'r':
          out += '\r';
          i += 2;
          break;
        case 't':
          out += '\t';
          i += 2;
          break;
        case 'b':
          out += '\b';
          i += 2;
          break;
        case 'f':
          out += '\f';
          i += 2;
          break;
        case '"':
          out += '"';
          i += 2;
          break;
        case '\\':
          out += '\\';
          i += 2;
          break;
        case '/':
          out += '/';
          i += 2;
          break;
        case 'u': {
          if (i + 6 > raw.length) {
            return out;
          }
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            out += 'u';
            i += 2;
          }
          break;
        }
        default:
          out += next;
          i += 2;
          break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
