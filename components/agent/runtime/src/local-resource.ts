import {
  defineAgentResource,
  type AgentActivityPresentationField,
  type AgentResource,
  type AgentResourceDefinition,
  type AgentResourceDescriptor,
  type AgentResourceReadRequest,
  type AgentResourceReadResult,
  type AgentResourceUri,
  type JsonObject,
  type JsonValue,
} from "@seashard/plugin-sdk";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentRuntimePreparedResourceRead, AgentRuntimeResourceSnapshot } from "./runtime";

const maximumLocalReadRanges = 20;
const maximumLocalReadRangeLength = 2_000;

const localResourceDescriptor: AgentResourceDescriptor = {
  description:
    "读取当前 Agent Session 持久化目录中的文件或目录。local:// 表示根目录，后面可以追加任意层级的相对路径。",
  inputSchema: {
    type: "object",
    properties: {
      ranges: {
        type: "array",
        minItems: 1,
        maxItems: maximumLocalReadRanges,
        description: "需要一次读取的文本行范围，按声明顺序返回。",
        items: {
          type: "object",
          properties: {
            start: {
              type: "integer",
              minimum: 1,
              description: "起始行，第一行为 1。",
            },
            length: {
              type: "integer",
              minimum: 1,
              maximum: maximumLocalReadRangeLength,
              description: "从起始行开始读取的行数。",
            },
          },
          required: ["start", "length"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  outputDescription:
    "文本文件返回完整内容或多段行范围；二进制文件返回 Base64 内容；目录返回按名称稳定排序的全部直接子项。",
  examples: [
    {},
    {
      ranges: [
        { start: 1, length: 10 },
        { start: 500, length: 11 },
        { start: 700, length: 1 },
      ],
    },
  ],
  help: [
    "URI 不携带 Session ID，始终绑定当前 Agent Session。",
    "文件路径必须是 Session 目录内的相对路径。",
    "ranges 只用于文本文件；每组使用一基 start 和正整数 length。",
  ].join("\n"),
  presentation: { title: "读取local://" },
};

interface LocalReadRange {
  readonly start: number;
  readonly length: number;
}

interface LocalReadInput {
  readonly ranges?: readonly LocalReadRange[];
}

/**
 * 将 Agent 自有的 local:// Resolver 合并到 Invocation 资源快照。
 * Resolver 在 Session 建立 Invocation 时绑定物理目录，因此 URI 无法切换到其他会话。
 */
export function bindAgentLocalResource(
  resources: AgentRuntimeResourceSnapshot,
  store: AgentSessionLocalStore,
): AgentRuntimeResourceSnapshot {
  const conflict = resources.definitions.find(({ pattern }) => resourceScheme(pattern) === "local");
  if (conflict) {
    throw new Error(`Agent 资源协议 local:// 由 Agent Runtime 保留：${conflict.pattern}`);
  }
  const resource = createAgentLocalResource(store);
  const definition: AgentResourceDefinition = {
    pattern: "local://",
    ...localResourceDescriptor,
  };

  return {
    definitions: [definition, ...resources.definitions],
    prepare(path, input) {
      if (resourceScheme(path) !== "local") return resources.prepare(path, input);
      return prepareLocalRead(definition, resource, path, input);
    },
  };
}

/** 当前 Session 的文件边界；读取和 Output Collector 写入共用同一套路径校验。 */
export class AgentSessionLocalStore {
  constructor(readonly sessionDirectory: string) {}

  async read(
    uri: AgentResourceUri,
    input: LocalReadInput,
    signal?: AbortSignal,
  ): Promise<AgentResourceReadResult> {
    throwIfAborted(signal);
    const target = await this.resolveExistingPath(uri.path);
    const details = await lstat(target);
    if (details.isDirectory()) {
      if (input.ranges) throw new TypeError("local:// 目录不支持 ranges");
      return this.readDirectory(target, signal);
    }
    if (!details.isFile()) throw new TypeError(`local:// 目标既非文件也非目录：${uri.href}`);

    const bytes = await readFile(target, signal ? { signal } : undefined);
    throwIfAborted(signal);
    if (isUtf8(bytes)) {
      const text = bytes.toString("utf8");
      return {
        mimeType: textMimeType(target),
        content: selectTextRanges(text, input.ranges),
      };
    }
    if (input.ranges) {
      throw new TypeError("local:// 二进制文件不支持 ranges");
    }
    return {
      mimeType: binaryMimeType(target),
      content: {
        encoding: "base64",
        bytes: bytes.byteLength,
        data: bytes.toString("base64"),
      },
    };
  }

  /** Output Collector 只写入受控子目录，并用独占创建阻止链接替换和静默覆盖。 */
  async writeToolOutput(
    toolCallId: string,
    extension: "json" | "txt",
    content: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const root = await this.resolveSafeRoot();
    const outputDirectory = resolve(root, "tool-output");
    assertContainedPath(root, outputDirectory);
    try {
      await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const outputDetails = await lstat(outputDirectory);
    if (!outputDetails.isDirectory() || outputDetails.isSymbolicLink()) {
      throw new Error("Agent Session 的 tool-output 路径必须是普通目录");
    }
    const canonicalOutputDirectory = await realpath(outputDirectory);
    assertContainedPath(root, canonicalOutputDirectory);

    const fileName = `${safeToolCallStem(toolCallId)}.${extension}`;
    const target = resolve(canonicalOutputDirectory, fileName);
    assertContainedPath(canonicalOutputDirectory, target);
    const file = await open(target, "wx", 0o600);
    try {
      throwIfAborted(signal);
      await file.writeFile(content, "utf8");
      throwIfAborted(signal);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    await file.close();
    return `local://tool-output/${fileName}`;
  }

  private async readDirectory(
    target: string,
    signal?: AbortSignal,
  ): Promise<AgentResourceReadResult<JsonObject>> {
    const entries = (await readdir(target, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, kind: directoryEntryKind(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    throwIfAborted(signal);
    return {
      mimeType: "application/vnd.seashard.directory+json",
      content: {
        entries,
        pagination: {
          offset: 1,
          limit: entries.length,
          totalEntries: entries.length,
          hasMore: false,
        },
      },
    };
  }

  private async resolveExistingPath(path: string): Promise<string> {
    const root = await this.resolveSafeRoot();
    if (!path) return root;
    let target = root;
    for (const segment of path.split("/")) {
      validateLocalPathSegment(segment);
      target = resolve(target, segment);
      assertContainedPath(root, target);
      const details = await lstat(target);
      if (details.isSymbolicLink()) {
        throw new Error(`local:// 禁止读取符号链接或 Junction：${path}`);
      }
    }
    const canonicalTarget = await realpath(target);
    assertContainedPath(root, canonicalTarget);
    return canonicalTarget;
  }

  private async resolveSafeRoot(): Promise<string> {
    const details = await lstat(this.sessionDirectory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Agent Session 本地资源根路径必须是普通目录");
    }
    return realpath(this.sessionDirectory);
  }
}

function createAgentLocalResource(store: AgentSessionLocalStore): AgentResource {
  return defineAgentResource({
    ...localResourceDescriptor,
    implementation: {
      read: (request, context) =>
        store.read(request.uri, parseLocalReadInput(request.input), context.signal),
      presentResult: (_request, result) => presentLocalReadResult(result),
    },
  });
}

/**
 * local:// 的 Session 绑定发生在 Invocation 快照层，资源描述、读取和展示投影仍使用
 * 与普通注册资源相同的 AgentResource implementation Contract。
 */
function prepareLocalRead(
  definition: AgentResourceDefinition,
  resource: AgentResource,
  path: string,
  input: JsonValue,
): AgentRuntimePreparedResourceRead {
  const uri = parseLocalResourceUri(path);
  const options = parseLocalReadInput(input);
  const request: AgentResourceReadRequest = { uri, pathParams: {}, input };
  return {
    definition: {
      ...definition,
      presentation: { title: formatLocalReadTitle(uri, options) },
    },
    request,
    presentRequest: async () => undefined,
    read: async (context = {}) => resource.implementation.read(request, context),
    presentResult: async (result) => {
      const fields = await resource.implementation.presentResult?.(request, result);
      return fields?.length ? fields : undefined;
    },
  };
}

function parseLocalResourceUri(value: string): AgentResourceUri {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new TypeError(`local:// URI 不合法：${String(value)}`);
  }
  const matched = /^local:\/\/([^?#]*)$/iu.exec(value);
  if (!matched) throw new TypeError(`local:// URI 不合法：${value}`);
  const encodedPath = matched[1]!;
  if (encodedPath.startsWith("/") || encodedPath.endsWith("/") || encodedPath.includes("//")) {
    throw new TypeError(`local:// 路径不合法：${value}`);
  }
  const segments = encodedPath
    ? encodedPath.split("/").map((part) => decodeLocalPart(part, value))
    : [];
  for (const segment of segments) validateLocalPathSegment(segment);
  return {
    href: value,
    scheme: "local",
    path: segments.join("/"),
    query: {},
  };
}

function parseLocalReadInput(value: JsonValue): LocalReadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("local:// input 必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "ranges");
  if (unexpected.length)
    throw new TypeError(`local:// input 包含未知参数：${unexpected.join(", ")}`);
  if (value.ranges === undefined) return {};
  if (
    !Array.isArray(value.ranges) ||
    value.ranges.length === 0 ||
    value.ranges.length > maximumLocalReadRanges
  ) {
    throw new TypeError(`local:// ranges 必须包含 1～${maximumLocalReadRanges} 组范围`);
  }
  return {
    ranges: value.ranges.map((range, index) => parseLocalReadRange(range, index)),
  };
}

function parsePositiveInteger(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`local:// ${label} 必须是正整数`);
  }
  return value;
}

function parseLocalReadRange(value: JsonValue, index: number): LocalReadRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`local:// ranges[${index}] 必须是对象`);
  }
  const unexpected = Object.keys(value).filter((key) => key !== "start" && key !== "length");
  if (unexpected.length) {
    throw new TypeError(`local:// ranges[${index}] 包含未知参数：${unexpected.join(", ")}`);
  }
  const start = parsePositiveInteger(value.start, `ranges[${index}].start`);
  const length = parsePositiveInteger(value.length, `ranges[${index}].length`);
  if (start === undefined || length === undefined) {
    throw new TypeError(`local:// ranges[${index}] 必须同时包含 start 和 length`);
  }
  if (length > maximumLocalReadRangeLength) {
    throw new RangeError(
      `local:// ranges[${index}].length 不能超过 ${maximumLocalReadRangeLength}`,
    );
  }
  if (!Number.isSafeInteger(start + length - 1)) {
    throw new RangeError(`local:// ranges[${index}] 结束行超出安全整数范围`);
  }
  return { start, length };
}

function selectTextRanges(text: string, ranges: readonly LocalReadRange[] | undefined): string {
  if (!ranges) return text;
  const lines = text.split(/\r?\n/u);
  return ranges
    .map((range) => {
      const content = lines.slice(range.start - 1, range.start - 1 + range.length).join("\n");
      if (ranges.length === 1) return content;
      return `${formatRangeHeading(range)}\n${content}`;
    })
    .join("\n\n");
}

function formatRangeHeading(range: LocalReadRange): string {
  if (range.length === 1) return `[Line ${range.start}]`;
  return `[Lines ${range.start}-${range.start + range.length - 1}]`;
}

function formatLocalReadTitle(uri: AgentResourceUri, input: LocalReadInput): string {
  const ranges = input.ranges
    ?.map((range) =>
      range.length === 1
        ? `第${range.start}行`
        : `第${range.start}~${range.start + range.length - 1}行`,
    )
    .join("，");
  return `读取${uri.href}${ranges ?? ""}`;
}

function presentLocalReadResult(
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  if (
    result.content &&
    typeof result.content === "object" &&
    !Array.isArray(result.content) &&
    Array.isArray(result.content.entries)
  ) {
    return [{ value: String(result.content.entries.length), unit: "个结果" }];
  }
  return [];
}

function resourceScheme(value: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
}

function decodeLocalPart(value: string, uri: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError(`local:// URI 包含无效编码：${uri}`);
  }
}

function validateLocalPathSegment(segment: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    segment.includes(":") ||
    /^[A-Za-z]:/u.test(segment)
  ) {
    throw new TypeError(`local:// 路径段不合法：${segment}`);
  }
}

function assertContainedPath(root: string, target: string): void {
  const child = relative(root, target);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error("local:// 路径越过当前 Agent Session 目录");
}

function safeToolCallStem(toolCallId: string): string {
  const readable = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(toolCallId)
    ? toolCallId
    : createHash("sha256").update(toolCallId).digest("hex");
  return `call-${readable}`;
}

function directoryEntryKind(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symbolic-link";
  return "other";
}

function textMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".html":
      return "text/html";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".md":
      return "text/markdown";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

function binaryMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("调用已取消");
  error.name = "AbortError";
  throw error;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
