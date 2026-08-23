import type { JsonValue } from "@seashard/plugin-sdk";
import { Buffer } from "node:buffer";
import type { AgentSessionLocalStore } from "./local-resource";

const maximumModelOutputBytes = 100_000;
const maximumPreviewBytes = 64 * 1_024;

/**
 * 模型上下文的最后一道输出边界。领域分页在进入这里前完成；Collector 只负责
 * 保存过大的完整结果，并把内容前缀和可继续读取的英文指令交给模型。
 */
export class AgentOutputCollector {
  constructor(private readonly store: AgentSessionLocalStore) {}

  async collect(output: JsonValue, toolCallId: string, signal?: AbortSignal): Promise<JsonValue> {
    throwIfAborted(signal);
    if (typeof output === "string") {
      return this.collectOversizedText(output, toolCallId, "txt", signal);
    }

    const serialized = JSON.stringify(output, null, 2);
    if (Buffer.byteLength(serialized, "utf8") <= maximumModelOutputBytes) return output;
    return this.collectOversizedText(serialized, toolCallId, "json", signal);
  }

  private async collectOversizedText(
    content: string,
    toolCallId: string,
    extension: "json" | "txt",
    signal?: AbortSignal,
  ): Promise<string> {
    if (Buffer.byteLength(content, "utf8") <= maximumModelOutputBytes) return content;

    const resource = await this.store.writeToolOutput(toolCallId, extension, content, signal);
    const instruction = `Content is too long. Use read with path "${resource}" to view the complete output.`;
    const preview = truncateUtf8Prefix(content, maximumPreviewBytes);
    return `${preview}${preview.endsWith("\n") ? "" : "\n"}${instruction}`;
  }
}

function truncateUtf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && isUtf8Continuation(bytes[end]!)) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function isUtf8Continuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("调用已取消");
  error.name = "AbortError";
  throw error;
}
