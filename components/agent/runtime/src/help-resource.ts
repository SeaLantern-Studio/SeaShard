import {
  type AgentResource,
  type AgentResourceDefinition,
  type AgentResourceDescriptor,
  type AgentResourceReadRequest,
  type AgentResourceUri,
  type JsonValue,
} from "@seashard/plugin-sdk";
import type {
  AgentRuntimePreparedResourceRead,
  AgentRuntimeResourceSnapshot,
  AgentRuntimeTool,
} from "./runtime";

const helpResourceDescriptor: AgentResourceDescriptor = {
  description:
    "读取当前 Invocation 中真实可用的工具与资源说明。可以从 help:// 逐层进入 tool 或 resource 目录。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputDescription:
    "返回由当前 Tool Registry 与 Resource Registry 快照动态生成的 Markdown 能力目录或详细说明。",
  examples: [{}],
  help: [
    "帮助内容直接来自当前 Invocation 的能力快照，不维护第二份手写目录。",
    "工具帮助使用 help://tool/<namespace>/<name>。",
    "资源帮助使用 help://resource/<scheme>。",
  ].join("\n"),
  presentation: { title: "获取帮助", icon: "help" },
};

interface AgentHelpCatalog {
  readonly tools: readonly AgentRuntimeTool[];
  readonly resources: readonly AgentResourceDefinition[];
}

/**
 * 把 Help Resolver 绑定到已经冻结的 Invocation 能力快照。
 * Local Resolver 必须先完成绑定，这样 help://resource/local 才能反映本次调用真正可用的参数。
 */
export function bindAgentHelpResource(
  resources: AgentRuntimeResourceSnapshot,
  tools: readonly AgentRuntimeTool[],
): AgentRuntimeResourceSnapshot {
  const conflict = resources.definitions.find(({ pattern }) => resourceScheme(pattern) === "help");
  if (conflict) {
    throw new Error(`Agent 资源协议 help:// 由 Agent Runtime 保留：${conflict.pattern}`);
  }

  const definition: AgentResourceDefinition = {
    pattern: "help://",
    ...helpResourceDescriptor,
  };
  const definitions = [definition, ...resources.definitions];
  const catalog: AgentHelpCatalog = {
    tools: [...tools].sort((left, right) => left.name.localeCompare(right.name)),
    resources: [...definitions].sort((left, right) => left.pattern.localeCompare(right.pattern)),
  };
  const resource = createAgentHelpResource(catalog);

  return {
    definitions,
    prepare(path, input) {
      if (resourceScheme(path) !== "help") return resources.prepare(path, input);
      return prepareHelpRead(definition, resource, path, input);
    },
  };
}

function createAgentHelpResource(catalog: AgentHelpCatalog): AgentResource {
  return {
    ...helpResourceDescriptor,
    implementation: {
      read(request, context) {
        throwIfAborted(context.signal);
        const content = renderHelpMarkdown(request.uri, catalog);
        throwIfAborted(context.signal);
        return {
          mimeType: "text/markdown; charset=utf-8",
          content,
        };
      },
    },
  };
}

/** Help 与 Local 一样拥有可变 URI，因此在 Invocation 快照层完成解析和卡片标题投影。 */
function prepareHelpRead(
  definition: AgentResourceDefinition,
  resource: AgentResource,
  path: string,
  input: JsonValue,
): AgentRuntimePreparedResourceRead {
  const uri = parseHelpResourceUri(path);
  parseHelpReadInput(input);
  const request: AgentResourceReadRequest = { uri, pathParams: {}, input };
  return {
    definition: {
      ...definition,
      presentation: { title: formatHelpReadTitle(uri), icon: "help" },
    },
    request,
    presentRequest: async () => undefined,
    read: async (context = {}) => resource.implementation.read(request, context),
    presentResult: async () => undefined,
  };
}

function renderHelpMarkdown(uri: AgentResourceUri, catalog: AgentHelpCatalog): string {
  const segments = uri.path ? uri.path.split("/") : [];
  if (!segments.length) return renderHelpRoot();

  if (segments[0] === "tool") {
    if (segments.length === 1) return renderToolRoot(catalog.tools);
    if (segments.length === 2) return renderToolNamespace(uri, segments[1]!, catalog.tools);
    if (segments.length === 3) {
      return renderToolDefinition(uri, segments[1]!, segments[2]!, catalog.tools);
    }
  }

  if (segments[0] === "resource") {
    if (segments.length === 1) return renderResourceRoot(catalog.resources);
    if (segments.length === 2) {
      return renderResourceScheme(uri, segments[1]!, catalog.resources);
    }
  }

  throw helpResourceNotFound(uri);
}

function renderHelpRoot(): string {
  return [
    "# Agent 能力帮助",
    "",
    "- `help://tool` — 当前 Invocation 可用的 Function Call 工具。",
    "- `help://resource` — 当前 Invocation 可用的只读资源协议。",
  ].join("\n");
}

function formatHelpReadTitle(uri: AgentResourceUri): string {
  const segments = uri.path ? uri.path.split("/") : [];
  if (!segments.length) return "获取帮助";
  if (segments.length === 1) {
    if (segments[0] === "tool") return "获取帮助: tools";
    if (segments[0] === "resource") return "获取帮助: resources";
  }
  return `获取帮助: ${segments.at(-1)}`;
}

function renderToolRoot(tools: readonly AgentRuntimeTool[]): string {
  const namespaces = [...new Set(tools.map(({ definition }) => definition.namespace))].sort();
  return [
    "# 工具帮助",
    "",
    ...(namespaces.length
      ? namespaces.map((namespace) => {
          const count = tools.filter(({ definition }) => definition.namespace === namespace).length;
          return `- \`help://tool/${namespace}\` — ${count} 个工具。`;
        })
      : ["当前 Invocation 没有可用工具。"]),
  ].join("\n");
}

function renderToolNamespace(
  uri: AgentResourceUri,
  namespace: string,
  tools: readonly AgentRuntimeTool[],
): string {
  const matches = tools.filter(({ definition }) => definition.namespace === namespace);
  if (!matches.length) throw helpResourceNotFound(uri);
  return [
    `# ${namespace} 工具`,
    "",
    ...matches.map(
      ({ name, definition }) =>
        `- \`help://tool/${namespace}/${definition.name}\` — \`${name}\`，${singleLine(definition.description)}`,
    ),
  ].join("\n");
}

function renderToolDefinition(
  uri: AgentResourceUri,
  namespace: string,
  name: string,
  tools: readonly AgentRuntimeTool[],
): string {
  const tool = tools.find(
    ({ definition }) => definition.namespace === namespace && definition.name === name,
  );
  if (!tool) throw helpResourceNotFound(uri);

  const { definition } = tool;
  const lines = [
    `# ${definition.title}`,
    "",
    `- Function Call：\`${tool.name}\``,
    `- 命名空间：\`${definition.namespace}\``,
    `- 工具名称：\`${definition.name}\``,
    "",
    "## 说明",
    "",
    definition.description,
    "",
    "## 输入 JSON Schema",
    "",
    jsonCodeBlock(definition.inputSchema),
  ];
  appendJsonExamples(lines, definition.examples, 2);
  if (definition.outputDescription) {
    lines.push("", "## 返回说明", "", definition.outputDescription);
  }
  return lines.join("\n");
}

function renderResourceRoot(resources: readonly AgentResourceDefinition[]): string {
  const schemes = [...new Set(resources.map(({ pattern }) => resourceScheme(pattern)))].filter(
    (value): value is string => value !== undefined,
  );
  schemes.sort();
  return [
    "# 资源帮助",
    "",
    ...schemes.map((scheme) => {
      const count = resources.filter(({ pattern }) => resourceScheme(pattern) === scheme).length;
      return `- \`help://resource/${scheme}\` — ${count} 个 URI 模式。`;
    }),
  ].join("\n");
}

function renderResourceScheme(
  uri: AgentResourceUri,
  scheme: string,
  resources: readonly AgentResourceDefinition[],
): string {
  const matches = resources.filter(({ pattern }) => resourceScheme(pattern) === scheme);
  if (!matches.length) throw helpResourceNotFound(uri);

  const lines = [`# \`${scheme}://\` 资源`, ""];
  for (const definition of matches) {
    lines.push(
      `## \`${definition.pattern}\``,
      "",
      definition.description,
      "",
      "### 路径参数",
      "",
      formatPathParameters(definition.pattern),
      "",
      "### 输入 JSON Schema",
      "",
      jsonCodeBlock(definition.inputSchema),
    );
    appendJsonExamples(lines, definition.examples, 3);
    if (definition.outputDescription) {
      lines.push("", "### 返回说明", "", definition.outputDescription);
    }
    if (definition.help) {
      lines.push("", "### 详细说明", "", definition.help);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function appendJsonExamples(
  lines: string[],
  examples: readonly JsonValue[] | undefined,
  headingLevel: 2 | 3,
): void {
  if (!examples?.length) return;
  lines.push("", `${"#".repeat(headingLevel)} 输入示例`);
  for (const [index, example] of examples.entries()) {
    if (examples.length > 1) lines.push("", `示例 ${index + 1}：`);
    lines.push("", jsonCodeBlock(example));
  }
}

function formatPathParameters(pattern: string): string {
  const names = [...pattern.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]!);
  return names.length ? names.map((name) => `- \`${name}\``).join("\n") : "无。";
}

function jsonCodeBlock(value: JsonValue): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function parseHelpReadInput(value: JsonValue): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("help:// input 必须是对象");
  }
  const unexpected = Object.keys(value);
  if (unexpected.length) {
    throw new TypeError(`help:// input 包含未知参数：${unexpected.join(", ")}`);
  }
}

function parseHelpResourceUri(value: string): AgentResourceUri {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new TypeError(`help:// URI 不合法：${String(value)}`);
  }
  const matched = /^help:\/\/([^?#]*)$/iu.exec(value);
  if (!matched) throw new TypeError(`help:// URI 不合法：${value}`);
  const encodedPath = matched[1]!;
  if (encodedPath.startsWith("/") || encodedPath.endsWith("/") || encodedPath.includes("//")) {
    throw new TypeError(`help:// 路径不合法：${value}`);
  }
  const segments = encodedPath
    ? encodedPath.split("/").map((segment) => decodeHelpSegment(segment, value))
    : [];
  return {
    href: value,
    scheme: "help",
    path: segments.join("/"),
    query: {},
  };
}

function decodeHelpSegment(segment: string, uri: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\0]/u.test(decoded)) {
      throw new TypeError(`help:// 路径不合法：${uri}`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("help://")) throw error;
    throw new TypeError(`help:// URI 编码不合法：${uri}`);
  }
}

function helpResourceNotFound(uri: AgentResourceUri): Error {
  return new Error(`Agent 帮助资源不存在：${uri.href}`);
}

function resourceScheme(value: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("调用已取消");
  error.name = "AbortError";
  throw error;
}
