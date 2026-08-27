import type {
  ServerConfigurationCatalog,
  ServerConfigurationDocument,
  ServerConfigurationFile,
  ServerConfigurationWriteRequest,
} from "@seashard/contracts";
import {
  defineAgentResource,
  type AgentActivityPresentationField,
  type AgentResource,
  type AgentResourceExecutionContext,
  type AgentResourceReadRequest,
  type AgentResourceReadResult,
  type AgentToolExecutionContext,
  type JsonObject,
  type JsonValue,
  type PluginContext,
} from "@seashard/plugin-sdk";

const maximumConfigurationPathLength = 512;
const maximumConfigurationContentLength = 1_000_000;
const defaultExcerptLength = 20_000;
const maximumExcerptLength = 50_000;
const maximumExcerptStart = 1_000_000;

const resourceInputProperties: Readonly<Record<string, true>> = {
  path: true,
  start: true,
  length: true,
};
const writeInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  path: true,
  content: true,
  expectedRevision: true,
};

export interface ServerConfigurationAgentRegistrationOptions {
  list(instanceId: string): Promise<ServerConfigurationCatalog>;
  read(instanceId: string, path: string): Promise<ServerConfigurationDocument>;
  write(request: ServerConfigurationWriteRequest): Promise<ServerConfigurationDocument>;
}

interface ConfigurationReadInput {
  readonly path?: string;
  readonly start: number;
  readonly length: number;
}

interface ConfigurationWriteInput extends ServerConfigurationWriteRequest {}

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  description: "服务器实例 ID；可先读取 server://instances 获取。",
};

const configurationPathProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumConfigurationPathLength,
  description: "配置目录返回的实例内相对路径；不得传入宿主绝对路径。",
};

const configurationResourceInputSchema: JsonObject = {
  type: "object",
  properties: {
    path: configurationPathProperty,
    start: {
      type: "integer",
      minimum: 0,
      maximum: maximumExcerptStart,
      default: 0,
      description: "读取文件时从零开始的字符偏移。",
    },
    length: {
      type: "integer",
      minimum: 1,
      maximum: maximumExcerptLength,
      default: defaultExcerptLength,
      description: "读取文件时最多返回的字符数。",
    },
  },
  additionalProperties: false,
};

const writeConfigurationInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    path: configurationPathProperty,
    content: {
      type: "string",
      maxLength: maximumConfigurationContentLength,
      description: "完整的新配置正文；不得包含空字符，UTF-8 编码后不得超过 1 MB。",
    },
    expectedRevision: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
      description: "读取配置时返回的 revision；内容已被其他来源修改时写入会被拒绝。",
    },
  },
  required: ["instanceId", "path", "content", "expectedRevision"],
  additionalProperties: false,
};

/**
 * 配置组件自行声明 Agent 资源和写入工具，并继续复用 UI 所调用的目录、读取与乐观锁事务。
 * 模型只能使用实例 ID 和组件已经发布的相对路径，配置根目录不会越过领域边界。
 */
export function registerServerConfigurationAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerConfigurationAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/config": createServerConfigurationResource(options),
  });

  context.agentTool(
    {
      namespace: "server",
      name: "write-config",
      title: "保存服务器配置",
      description:
        "使用读取时取得的 revision 保存一个已发布的服务器配置文件；写入前会再次校验实例边界并创建备份。",
      confirmationLevel: 1,
      inputSchema: writeConfigurationInputSchema,
      outputDescription:
        "返回已保存文件的相对路径、最新 revision、编码、修改时间和正文字符数，不回传完整正文或宿主路径。",
      examples: [
        {
          instanceId: "550e8400-e29b-41d4-a716-446655440000",
          path: "server.properties",
          content: "server-port=25565\nmotd=SeaShard\n",
          expectedRevision: "0".repeat(64),
        },
      ],
    },
    (input, execution) => writeServerConfiguration(options, input, execution),
  );
}

export function createServerConfigurationResource(
  options: ServerConfigurationAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "列出指定服务器实例中可编辑的配置文件，或按相对路径分段读取一个 UTF-8 配置文件；结果不包含配置根目录等宿主绝对路径。",
    inputSchema: configurationResourceInputSchema,
    outputDescription:
      "未提供 path 时返回有界配置目录；提供 path 时返回文件元数据、revision 和最多 50000 个字符的正文片段。",
    examples: [{}, { path: "server.properties", start: 0, length: 20_000 }],
    help: "修改配置使用 server_write-config，并传入读取文件时取得的完整 revision。",
    presentation: { title: "读取服务器配置" },
    implementation: {
      read: (request, execution) => readServerConfiguration(options, request, execution),
      presentRequest: presentConfigurationRequest,
      presentResult: presentConfigurationResult,
    },
  });
}

async function readServerConfiguration(
  options: ServerConfigurationAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const input = parseConfigurationReadInput(request.input);

  if (input.path === undefined) {
    const catalog = await options.list(instanceId);
    execution.signal?.throwIfAborted();
    return { mimeType: "application/json", content: projectConfigurationCatalog(catalog) };
  }

  const document = await options.read(instanceId, input.path);
  execution.signal?.throwIfAborted();
  return {
    mimeType: "application/json",
    content: projectConfigurationDocument(document, input.start, input.length),
  };
}

function presentConfigurationRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const input = parseConfigurationReadInput(request.input);
  return input.path === undefined
    ? [{ label: "服务器", value: instanceId }, { value: "配置目录" }]
    : [
        { label: "服务器", value: instanceId },
        { label: "文件", value: input.path },
        { label: "范围", value: `${input.start}～${input.start + input.length - 1}`, unit: "字符" },
      ];
}

function presentConfigurationResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const content = expectOutputObject(result.content, "配置资源结果");
  const mode = expectOutputString(content.mode, "mode");
  if (mode === "catalog") {
    return [{ value: String(expectOutputNumber(content.fileCount, "fileCount")), unit: "个文件" }];
  }
  if (mode === "document") {
    const range = expectOutputObject(content.range, "range");
    return [{ value: String(expectOutputNumber(range.length, "range.length")), unit: "个字符" }];
  }
  throw new TypeError("Agent 配置资源结果 mode 无效");
}

async function writeServerConfiguration(
  options: ServerConfigurationAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseConfigurationWriteInput(value);
  const document = await options.write(input);
  execution.signal?.throwIfAborted();
  return projectSavedConfiguration(document);
}

/** 配置目录保留可复用的相对路径和分类，明确移除领域 DTO 中的 configurationRootPath。 */
function projectConfigurationCatalog(catalog: ServerConfigurationCatalog): JsonObject {
  const serverFiles = projectConfigurationFiles(catalog.serverFiles);
  const otherFiles = projectConfigurationFiles(catalog.otherFiles);
  const plugins = catalog.plugins.map((plugin) => ({
    name: plugin.name,
    files: projectConfigurationFiles(plugin.files),
  }));
  const originalFileCount =
    catalog.serverFiles.length +
    catalog.otherFiles.length +
    catalog.plugins.reduce((total, plugin) => total + plugin.files.length, 0);
  const fileCount =
    serverFiles.length +
    otherFiles.length +
    plugins.reduce((total, plugin) => total + plugin.files.length, 0);

  return {
    mode: "catalog",
    instanceId: catalog.instanceId,
    ...(catalog.serverType === undefined ? {} : { serverType: catalog.serverType }),
    pluginSupported: catalog.pluginSupported,
    serverFiles,
    otherFiles,
    plugins,
    fileCount,
    omittedFileCount: originalFileCount - fileCount,
  };
}

function projectConfigurationFiles(files: readonly ServerConfigurationFile[]): JsonObject[] {
  return files
    .filter((file) => isAgentUsableConfigurationPath(file.path))
    .map((file) => projectConfigurationFile(file));
}

function projectConfigurationFile(file: ServerConfigurationFile): JsonObject {
  return {
    path: file.path,
    name: file.name,
    kind: file.kind,
    scope: file.scope,
    ...(file.pluginName === undefined ? {} : { pluginName: file.pluginName }),
  };
}

/** 正文按字符窗口有界投影；revision 始终针对完整原始文件，供后续乐观锁写入。 */
function projectConfigurationDocument(
  document: ServerConfigurationDocument,
  start: number,
  length: number,
): JsonObject {
  const content = document.content.slice(start, start + length);
  return {
    mode: "document",
    ...projectConfigurationFile(document),
    instanceId: document.instanceId,
    revision: document.revision,
    encoding: document.encoding,
    modifiedAt: document.modifiedAt,
    content,
    range: {
      start,
      length: content.length,
      totalLength: document.content.length,
      hasMore: start + content.length < document.content.length,
    },
  };
}

/** 写入结果只确认领域事务产物，避免把完整配置正文再次送入模型上下文。 */
function projectSavedConfiguration(document: ServerConfigurationDocument): JsonObject {
  return {
    saved: true,
    ...projectConfigurationFile(document),
    instanceId: document.instanceId,
    revision: document.revision,
    encoding: document.encoding,
    modifiedAt: document.modifiedAt,
    contentLength: document.content.length,
  };
}

function parseConfigurationReadInput(value: JsonValue): ConfigurationReadInput {
  const input = expectObject(value, "服务器配置资源", resourceInputProperties);
  const path = readOptionalConfigurationPath(input.path);
  if (path === undefined && (input.start !== undefined || input.length !== undefined)) {
    throw new TypeError("服务器配置资源只有读取文件时才能指定 start 或 length");
  }
  return {
    ...(path === undefined ? {} : { path }),
    start: readOptionalInteger(input.start, "start", 0, maximumExcerptStart) ?? 0,
    length:
      readOptionalInteger(input.length, "length", 1, maximumExcerptLength) ?? defaultExcerptLength,
  };
}

function parseConfigurationWriteInput(value: JsonValue): ConfigurationWriteInput {
  const input = expectObject(value, "server_write-config", writeInputProperties);
  return {
    instanceId: expectInstanceId(input.instanceId),
    path: expectConfigurationPath(input.path),
    content: expectConfigurationContent(input.content),
    expectedRevision: expectRevision(input.expectedRevision),
  };
}

function expectObject(
  value: JsonValue,
  label: string,
  allowedProperties: Readonly<Record<string, true>>,
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} input 必须是对象`);
  }
  const unknownProperty = Object.keys(value).find((key) => allowedProperties[key] !== true);
  if (unknownProperty) throw new TypeError(`${label} 不支持参数 ${unknownProperty}`);
  return value;
}

function expectInstanceId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError("server configuration instance id must be a plain identifier");
  }
  return value;
}

function readOptionalConfigurationPath(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : expectConfigurationPath(value);
}

function expectConfigurationPath(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    value.length > maximumConfigurationPathLength ||
    !isAgentUsableConfigurationPath(value)
  ) {
    throw new TypeError("配置路径必须是长度不超过 512 的规范实例内相对路径");
  }
  return value;
}

function isAgentUsableConfigurationPath(path: string): boolean {
  return (
    path.length > 0 &&
    Boolean(path.trim()) &&
    path.length <= maximumConfigurationPathLength &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function expectConfigurationContent(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    value.length > maximumConfigurationContentLength ||
    value.includes("\0")
  ) {
    throw new TypeError("配置内容必须是不含空字符且长度不超过 1000000 的文本");
  }
  return value;
}

function expectRevision(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("配置 revision 必须是 64 位小写十六进制字符串");
  }
  return value;
}

function readOptionalInteger(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} 必须是 ${minimum}～${maximum} 的安全整数`);
  }
  return value;
}

function expectOutputObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Agent 输出缺少 ${label}`);
  }
  return value;
}

function expectOutputString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}

function expectOutputNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}
