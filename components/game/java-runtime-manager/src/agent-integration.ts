import type { JavaInstallationSnapshot, JavaInstallationSource } from "@seashard/contracts";
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

const defaultPage = 1;
const defaultPageSize = 10;
const maximumPage = 10_000;
const maximumPageSize = 50;
const maximumJavaMajorVersion = 255;
const javaInstallationSources = [
  "java-home",
  "path",
  "registry",
  "filesystem",
  "manual",
] as const satisfies readonly JavaInstallationSource[];
const javaInstallationsInputProperties: Readonly<Record<string, true>> = {
  page: true,
  pageSize: true,
  majorVersion: true,
  source: true,
  disabled: true,
};
const setDisabledInputProperties: Readonly<Record<string, true>> = {
  installationId: true,
  disabled: true,
};
const installationIdInputProperties: Readonly<Record<string, true>> = {
  installationId: true,
};

export interface JavaRuntimeAgentRegistrationOptions {
  scan(): Promise<readonly JavaInstallationSnapshot[]>;
  setDisabled(installationId: string, disabled: boolean): Promise<boolean>;
  remove(executablePath: string): Promise<boolean>;
}

interface JavaInstallationsQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly majorVersion?: number;
  readonly source?: JavaInstallationSource;
  readonly disabled?: boolean;
}

interface JavaInstallationIdInput {
  readonly installationId: string;
}

interface JavaInstallationDisabledInput extends JavaInstallationIdInput {
  readonly disabled: boolean;
}

interface JavaInstallationsPage {
  readonly items: readonly JsonObject[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
    readonly hasMore: boolean;
  };
}

const installationIdProperty: JsonObject = {
  type: "string",
  minLength: 16,
  maxLength: 16,
  pattern: "^[a-f0-9]{16}$",
  description: "Java 安装稳定 ID；可先读取 java://installations 获取。",
};

const javaInstallationsInputSchema: JsonObject = {
  type: "object",
  properties: {
    page: {
      type: "integer",
      minimum: 1,
      maximum: maximumPage,
      default: defaultPage,
      description: "页码，第一页为 1。",
    },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: maximumPageSize,
      default: defaultPageSize,
      description: "每页最多返回的 Java 安装数量。",
    },
    majorVersion: {
      type: "integer",
      minimum: 1,
      maximum: maximumJavaMajorVersion,
      description: "只返回指定 Java 主版本。",
    },
    source: {
      type: "string",
      enum: [...javaInstallationSources],
      description: "只返回指定发现来源的 Java 安装。",
    },
    disabled: {
      type: "boolean",
      description: "只返回已禁用或已启用的 Java 安装。",
    },
  },
  additionalProperties: false,
};

const setDisabledInputSchema: JsonObject = {
  type: "object",
  properties: {
    installationId: installationIdProperty,
    disabled: {
      type: "boolean",
      description: "true 表示从 SeaShard 自动选择候选中排除；false 表示重新启用。",
    },
  },
  required: ["installationId", "disabled"],
  additionalProperties: false,
};

const forgetManualInputSchema: JsonObject = {
  type: "object",
  properties: {
    installationId: installationIdProperty,
  },
  required: ["installationId"],
  additionalProperties: false,
};

/**
 * Java Runtime Manager 自行声明 Agent 能力，并复用 UI 所调用的扫描与状态事务。
 * 模型只使用稳定安装 ID；宿主路径始终留在组件内部。
 */
export function registerJavaRuntimeAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: JavaRuntimeAgentRegistrationOptions,
): void {
  // 手动新增必须经过 Desktop 文件选择器；Agent 不接收任意宿主路径，也不暴露 inspect。
  // 自动发现项没有可移除记录，因此 forget-manual 仅接受扫描结果中的 manual 安装 ID。
  context.agentResources({
    "java://installations": createJavaInstallationsResource(options),
  });

  context.agentTool(
    {
      namespace: "java",
      name: "set-disabled",
      title: "设置 Java 启用状态",
      description:
        "启用或禁用一个已发现的 Java 安装；禁用只影响 SeaShard 自动选择，不修改本地 Java 文件。",
      confirmationLevel: 1,
      inputSchema: setDisabledInputSchema,
      outputDescription: "返回 Java 安装的最小安全投影、目标状态以及本次是否发生变化。",
      examples: [{ installationId: "0123456789abcdef", disabled: true }],
    },
    (input, execution) => setJavaInstallationDisabled(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "java",
      name: "forget-manual",
      title: "移除手动 Java 记录",
      description:
        "从 SeaShard 中移除一个手动添加的 Java 记录；不会删除、卸载或修改本地 Java 文件。",
      confirmationLevel: 1,
      inputSchema: forgetManualInputSchema,
      outputDescription: "返回被移除记录的最小安全投影，并明确本地文件未被删除。",
      examples: [{ installationId: "0123456789abcdef" }],
    },
    (input, execution) => forgetManualJavaInstallation(options, input, execution),
  );
}

export function createJavaInstallationsResource(
  options: JavaRuntimeAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "扫描并读取 SeaShard 可用于服务器启动的 Java 安装，支持按主版本、来源和启用状态筛选；结果不包含可执行文件或 Java Home 的宿主绝对路径。",
    inputSchema: javaInstallationsInputSchema,
    outputDescription: "返回 Java 安装的最小安全投影和有界分页信息。",
    examples: [{ page: 1, pageSize: 10, majorVersion: 21, disabled: false }],
    help: "启用或禁用安装使用 java_set-disabled；移除手动记录使用 java_forget-manual。",
    presentation: { title: "读取 Java 安装" },
    implementation: {
      read: (request, execution) => readJavaInstallations(options, request, execution),
      presentRequest: presentJavaInstallationsRequest,
      presentResult: presentJavaInstallationsResult,
    },
  });
}

async function readJavaInstallations(
  options: JavaRuntimeAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const query = parseJavaInstallationsQuery(request.input);
  const installations = await options.scan();
  execution.signal?.throwIfAborted();

  const filtered = installations.filter(
    (installation) =>
      (query.majorVersion === undefined || installation.majorVersion === query.majorVersion) &&
      (query.source === undefined || installation.source === query.source) &&
      (query.disabled === undefined || installation.disabled === query.disabled),
  );
  const start = (query.page - 1) * query.pageSize;
  const items = filtered
    .slice(start, start + query.pageSize)
    .map((installation) => projectJavaInstallationForAgent(installation));
  const totalPages = Math.ceil(filtered.length / query.pageSize);

  return {
    mimeType: "application/json",
    content: {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: filtered.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

function presentJavaInstallationsRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseJavaInstallationsQuery(request.input);
  const start = (query.page - 1) * query.pageSize + 1;
  const end = start + query.pageSize - 1;
  return [
    { value: `${start}～${end}` },
    ...(query.majorVersion === undefined
      ? []
      : [{ label: "版本", value: `Java ${query.majorVersion}` }]),
    ...(query.source === undefined
      ? []
      : [{ label: "来源", value: displayJavaInstallationSource(query.source) }]),
    ...(query.disabled === undefined
      ? []
      : [{ label: "状态", value: query.disabled ? "已禁用" : "已启用" }]),
  ];
}

function presentJavaInstallationsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const page = parseJavaInstallationsPage(result.content);
  return [{ value: String(page.items.length), unit: "个结果" }];
}

async function setJavaInstallationDisabled(
  options: JavaRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseSetDisabledInput(value);
  const installation = await findJavaInstallation(options, input.installationId);
  execution.signal?.throwIfAborted();

  const changed = installation.disabled !== input.disabled;
  if (changed) {
    await options.setDisabled(input.installationId, input.disabled);
    execution.signal?.throwIfAborted();
  }

  return {
    installation: projectJavaInstallationForAgent({
      ...installation,
      disabled: input.disabled,
    }),
    changed,
  };
}

async function forgetManualJavaInstallation(
  options: JavaRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseInstallationIdInput(value, "java_forget-manual");
  const installation = await findJavaInstallation(options, input.installationId);
  execution.signal?.throwIfAborted();
  if (installation.source !== "manual") {
    throw new Error(`Java 安装不是手动记录，无法移除：${input.installationId}`);
  }

  const removed = await options.remove(installation.path);
  execution.signal?.throwIfAborted();
  if (!removed) {
    throw new Error(`Java 手动记录已不存在：${input.installationId}`);
  }
  return {
    installation: projectJavaInstallationForAgent(installation),
    removed: true,
    localFilesDeleted: false,
  };
}

async function findJavaInstallation(
  options: JavaRuntimeAgentRegistrationOptions,
  installationId: string,
): Promise<JavaInstallationSnapshot> {
  const installation = (await options.scan()).find(({ id }) => id === installationId);
  if (!installation) throw new Error(`Java 安装不存在：${installationId}`);
  return installation;
}

function parseJavaInstallationsQuery(value: JsonValue): JavaInstallationsQuery {
  const object = expectObject(value, "Java 安装资源 input");
  expectKnownProperties(object, javaInstallationsInputProperties, "Java 安装资源 input");
  const page = readBoundedInteger(object.page, "page", 1, maximumPage) ?? defaultPage;
  const pageSize =
    readBoundedInteger(object.pageSize, "pageSize", 1, maximumPageSize) ?? defaultPageSize;
  const majorVersion = readBoundedInteger(
    object.majorVersion,
    "majorVersion",
    1,
    maximumJavaMajorVersion,
  );
  const source = readJavaInstallationSource(object.source);
  const disabled = readOptionalBoolean(object.disabled, "disabled");
  return {
    page,
    pageSize,
    ...(majorVersion === undefined ? {} : { majorVersion }),
    ...(source === undefined ? {} : { source }),
    ...(disabled === undefined ? {} : { disabled }),
  };
}

function parseSetDisabledInput(value: JsonValue): JavaInstallationDisabledInput {
  const object = expectObject(value, "java_set-disabled input");
  expectKnownProperties(object, setDisabledInputProperties, "java_set-disabled input");
  const installationId = readInstallationId(object.installationId, "java_set-disabled");
  if (typeof object.disabled !== "boolean") {
    throw new TypeError("java_set-disabled disabled 必须是布尔值");
  }
  return { installationId, disabled: object.disabled };
}

function parseInstallationIdInput(value: JsonValue, label: string): JavaInstallationIdInput {
  const object = expectObject(value, `${label} input`);
  expectKnownProperties(object, installationIdInputProperties, `${label} input`);
  return { installationId: readInstallationId(object.installationId, label) };
}

function readInstallationId(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/u.test(value)) {
    throw new TypeError(`${label} installationId 必须是 16 位小写十六进制字符串`);
  }
  return value;
}

function expectObject(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return value;
}

function expectKnownProperties(
  value: Readonly<Record<string, JsonValue>>,
  allowed: Readonly<Record<string, true>>,
  label: string,
): void {
  const unknown = Object.keys(value).find((property) => !Object.hasOwn(allowed, property));
  if (unknown) throw new TypeError(`${label} 包含未知字段：${unknown}`);
}

function readBoundedInteger(
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
    throw new TypeError(`Java 安装资源 ${label} 必须是 ${minimum}～${maximum} 的整数`);
  }
  return value;
}

function readOptionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`Java 安装资源 ${label} 必须是布尔值`);
  }
  return value;
}

function readJavaInstallationSource(
  value: JsonValue | undefined,
): JavaInstallationSource | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !javaInstallationSources.includes(value as JavaInstallationSource)
  ) {
    throw new TypeError("Java 安装资源 source 不受支持");
  }
  return value as JavaInstallationSource;
}

function parseJavaInstallationsPage(value: JsonValue): JavaInstallationsPage {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new TypeError("Java 安装资源返回值缺少 items");
  }
  return value as unknown as JavaInstallationsPage;
}

/** Agent 投影保留选择 Java 所需语义，排除 executablePath 与 javaHome。 */
function projectJavaInstallationForAgent(installation: JavaInstallationSnapshot): JsonObject {
  return {
    id: installation.id,
    version: installation.version,
    majorVersion: installation.majorVersion,
    vendor: installation.vendor,
    architecture: installation.architecture,
    is64Bit: installation.is64Bit,
    source: installation.source,
    disabled: installation.disabled,
  };
}

function displayJavaInstallationSource(source: JavaInstallationSource): string {
  switch (source) {
    case "java-home":
      return "JAVA_HOME";
    case "path":
      return "PATH";
    case "registry":
      return "系统注册表";
    case "filesystem":
      return "文件系统";
    case "manual":
      return "手动添加";
  }
}
