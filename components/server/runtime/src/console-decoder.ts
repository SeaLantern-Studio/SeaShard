const javaToolOptionsNoticePattern = /^Picked up JAVA_TOOL_OPTIONS:/u;
const utf8ConsoleDecoder = new TextDecoder("utf-8", { fatal: true });
const gb18030ConsoleDecoder = new TextDecoder("gb18030");

export class ProcessLineDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.pending = this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
    this.flushCompleteLines();
  }

  end(): void {
    if (this.pending.length > 0) this.emitBytes(this.pending);
    this.pending = Buffer.alloc(0);
  }

  private flushCompleteLines(): void {
    let lineStart = 0;
    for (let index = 0; index < this.pending.length; index += 1) {
      if (this.pending[index] !== 0x0a) continue;
      this.emitBytes(this.pending.subarray(lineStart, index));
      lineStart = index + 1;
    }
    if (lineStart > 0) this.pending = Buffer.from(this.pending.subarray(lineStart));
  }

  private emitBytes(bytes: Buffer): void {
    const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    const line = normalizeProcessLine(decodeConsoleBytes(content));
    if (line !== undefined) this.emit(line);
  }
}

function decodeConsoleBytes(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  try {
    return utf8ConsoleDecoder.decode(bytes);
  } catch {
    // 部分 Windows 核心及其子安装器仍直接向管道写入 GBK/GB18030。
    return gb18030ConsoleDecoder.decode(bytes);
  }
}

function normalizeProcessLine(text: string): string | undefined {
  const normalized = stripTerminalControlSequences(lastTerminalCarriageReturnFrame(text));
  return javaToolOptionsNoticePattern.test(normalized) ? undefined : normalized;
}

/**
 * 回车符会把终端光标移回当前行开头。进度条用它反复覆盖同一行，因此日志只保留最终帧，
 * 避免把 1% 到 100% 的所有刷新内容拼成一条超长文本。
 */
function lastTerminalCarriageReturnFrame(text: string): string {
  const lastCarriageReturn = text.lastIndexOf("\r");
  return lastCarriageReturn < 0 ? text : text.slice(lastCarriageReturn + 1);
}

/**
 * 移除终端标题（OSC）、颜色（CSI）和不可见控制字符，避免其进入 Renderer 标签解析。
 * 普通文本按 UTF-16 代码单元原样拼回，中文和代理对不会被改写。
 */
function stripTerminalControlSequences(text: string): string {
  let normalized = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < text.length) {
          const sequenceCode = text.charCodeAt(index);
          index += 1;
          if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) break;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < text.length) {
          const sequenceCode = text.charCodeAt(index);
          if (sequenceCode === 0x07) {
            index += 1;
            break;
          }
          if (sequenceCode === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      index += 1;
      continue;
    }
    normalized += text[index];
    index += 1;
  }
  return normalized;
}
