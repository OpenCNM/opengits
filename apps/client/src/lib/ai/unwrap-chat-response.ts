const RESPONSE_FIELD_PATTERN = /^\s*(?:```(?:json)?\s*)?\{\s*"response"\s*:\s*"/;

// Incrementally unwraps {"response":"..."} shells mid-stream while pausing on incomplete trailing escape sequences.
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
      break;
    }

    if (ch === '\\') {
      if (i + 1 >= raw.length) {
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
