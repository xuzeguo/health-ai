export interface SseParserOptions {
  onEvent: (event: string, data: string) => void;
}

// Line-oriented parsing handles CRLF even when CR and LF arrive separately.
// Incomplete frames at EOF are deliberately not dispatched.
export function createSseParser({ onEvent }: SseParserOptions) {
  let line = '';
  let skipLF = false;
  let event = '';
  let data: string[] = [];
  let size = 0;
  function consumeLine() {
    if (!line) {
      if (data.length) onEvent(event || 'message', data.join('\n'));
      event = '';
      data = [];
      size = 0;
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const name = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'event') event = value;
      if (name === 'data') data.push(value);
    }
    line = '';
  }
  return {
    feed(chunk: string) {
      for (const character of chunk) {
        if (skipLF && character === '\n') { skipLF = false; continue; }
        skipLF = false;
        if (++size > 1024 * 1024) throw new Error('SSE frame too large');
        if (character === '\r' || character === '\n') {
          consumeLine();
          skipLF = character === '\r';
        } else line += character;
      }
    },
  };
}
