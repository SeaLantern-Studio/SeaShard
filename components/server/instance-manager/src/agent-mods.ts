import type { ServerInstalledModSnapshot } from "@seashard/contracts";
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
const defaultPageSize = 20;
const maximumPage = 10_000;
const maximumPageSize = 50;
const maximumQueryLength = 200;
const maximumRelativePathLength = 1_024;
const maximumNameLength = 200;
const maximumVersionLength = 100;
const maximumDescriptionLength = 1_000;
const maximumSourceIdentityLength = 128;
const instanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u;

const resourceInputProperties: Readonly<Record<string, true>> = {
  query: true,
  disabled: true,
  page: true,
  pageSize: true,
};
const setDisabledInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  relativePath: true,
  disabled: true,
};
const modTargetInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  relativePath: true,
};

export interface ServerInstalledModAgentRegistrationOptions {
  listMods(
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<readonly ServerInstalledModSnapshot[]>;
  setModDisabled(
    instanceId: string,
    relativePath: string,
    disabled: boolean,
  ): Promise<ServerInstalledModSnapshot>;
  deleteMod(instanceId: string, relativePath: string): Promise<void>;
}

interface InstalledModsQuery {
  readonly query: string;
  readonly disabled?: boolean;
  readonly page: number;
  readonly pageSize: number;
}

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$",
  description: "服务器实例 ID；可先读取 server://instances 获取。",
};

const relativePathProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumRelativePathLength,
  description:
    "server://instances/{instanceId}/mods 返回的实例内 POSIX 相对路径；不能提交绝对路径或自行猜测路径。",
};

const installedModsInputSchema: JsonObject = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: maximumQueryLength,
      default: "",
      description: "按 Mod 名称、文件名或版本搜索；空字符串返回全部。",
    },
    disabled: {
      type: "boolean",
      description: "只返回已禁用或已启用的 Mod；省略时返回全部。",
    },
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
      description: "每页最多返回的 Mod 数量。",
    },
  },
  additionalProperties: false,
};

const setModDisabledInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    relativePath: relativePathProperty,
    disabled: {
      type: "boolean",
      description: "true 通过受控重命名禁用 Mod；false 恢复启用。",
    },
  },
  required: ["instanceId", "relativePath", "disabled"],
  additionalProperties: false,
};

const deleteModInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    relativePath: relativePathProperty,
  },
  required: ["instanceId", "relativePath"],
  additionalProperties: false,
};

/**
 * 实例管理组件拥有已安装 Mod 的扫描、受控重命名和删除事务。
 * Agent 只使用组件发布的实例内相对路径，绝不接触实例根目录或图标 Base64。
 */
export function registerServerInstalledModAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerInstalledModAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/mods": createServerInstalledModsResource(options),
  });

  context.agentTool(
    {
      namespace: "server",
      name: "set-mod-disabled",
      title: "设置服务器 Mod 启用状态",
      description:
        "启用或禁用已登记服务器实例中的一个 Mod；目标相对路径必须来自对应实例的 Mod 资源，状态通常在服务器下次启动后生效。",
      confirmationLevel: 1,
      inputSchema: setModDisabledInputSchema,
      outputDescription:
        "返回操作前后的 Mod 安全投影；重命名后 relativePath 可能变化，前后相同表示状态已经满足要求。",
      examples: [
        {
          instanceId: "server-1",
          relativePath: "mods/example-mod-1.0.0.jar",
          disabled: true,
        },
      ],
    },
    (input, execution) => setServerModDisabled(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "delete-mod",
      title: "删除服务器 Mod",
      description:
        "删除已登记服务器实例中的一个 Mod 文件，并同步清理该文件的资源来源记录；目标相对路径必须来自对应实例的 Mod 资源。",
      confirmationLevel: 1,
      inputSchema: deleteModInputSchema,
      outputDescription: "返回删除前的 Mod 安全投影；删除完成后的状态固定为 null。",
      examples: [
        {
          instanceId: "server-1",
          relativePath: "mods/example-mod-1.0.0.jar",
        },
      ],
    },
    (input, execution) => deleteServerMod(options, input, execution),
  );
}

export function createServerInstalledModsResource(
  options: ServerInstalledModAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定服务器实例中已安装的 Mod，支持名称、文件名、版本、启用状态和有界分页；relativePath 仅表示实例内路径，结果不包含宿主绝对路径、图标 Base64 或远程图标地址。",
    inputSchema: installedModsInputSchema,
    outputDescription: "返回最多 50 个 Mod 的安全投影和统一页码分页信息。",
    examples: [
      { query: "lithium", page: 1, pageSize: 20 },
      { disabled: true, page: 1, pageSize: 20 },
    ],
    help: "启停 Mod 使用 server_set-mod-disabled；删除 Mod 使用 server_delete-mod。",
    presentation: { title: "读取服务器 Mod" },
    implementation: {
      read: (request, execution) => readServerInstalledMods(options, request, execution),
      presentRequest: presentInstalledModsRequest,
      presentResult: presentInstalledModsResult,
    },
  });
}

async function readServerInstalledMods(
  options: ServerInstalledModAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const query = parseInstalledModsQuery(request.input);
  const mods = (await options.listMods(instanceId, execution.signal)).filter(
    (mod) =>
      (query.disabled === undefined || mod.disabled === query.disabled) &&
      matchesInstalledModQuery(mod, query.query),
  );
  execution.signal?.throwIfAborted();

  const start = (query.page - 1) * query.pageSize;
  const items = mods
    .slice(start, start + query.pageSize)
    .map((mod) => projectInstalledModForAgent(mod));
  const totalPages = Math.ceil(mods.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      instanceId,
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: mods.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

function presentInstalledModsRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseInstalledModsQuery(request.input);
  return [
    { value: expectInstanceId(request.pathParams.instanceId) },
    { label: "范围", value: pageRange(query.page, query.pageSize) },
    ...(query.query ? [{ label: "搜索", value: query.query }] : []),
    ...(query.disabled === undefined
      ? []
      : [{ label: "状态", value: query.disabled ? "已禁用" : "已启用" }]),
  ];
}

function presentInstalledModsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const output = expectObjectOutput(result.content, "服务器 Mod 资源结果");
  if (!Array.isArray(output.items)) throw new TypeError("服务器 Mod 资源结果缺少 items");
  return [{ value: String(output.items.length), unit: "个 Mod" }];
}

async function setServerModDisabled(
  options: ServerInstalledModAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseModTargetInput(value, "server_set-mod-disabled", true);
  const before = await findInstalledMod(
    options,
    input.instanceId,
    input.relativePath,
    execution.signal,
  );
  execution.signal?.throwIfAborted();

  // 幂等判断和文件重命名全部交给实例管理器，适配器只保留领域事务的真实前后状态。
  const after = await options.setModDisabled(input.instanceId, input.relativePath, input.disabled!);
  execution.signal?.throwIfAborted();
  return {
    before: projectInstalledModForAgent(before),
    after: projectInstalledModForAgent(after),
  };
}

async function deleteServerMod(
  options: ServerInstalledModAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseModTargetInput(value, "server_delete-mod", false);
  const before = await findInstalledMod(
    options,
    input.instanceId,
    input.relativePath,
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  await options.deleteMod(input.instanceId, input.relativePath);
  execution.signal?.throwIfAborted();
  return { before: projectInstalledModForAgent(before), after: null };
}

async function findInstalledMod(
  options: ServerInstalledModAgentRegistrationOptions,
  instanceId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<ServerInstalledModSnapshot> {
  const mod = (await options.listMods(instanceId, signal)).find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (!mod) throw new Error(`服务器实例 ${instanceId} 中不存在 Mod：${relativePath}`);
  return mod;
}

/** Mod 投影保留可操作身份与来源，隐藏宿主路径、JAR 内图标和远程图标。 */
export function projectInstalledModForAgent(mod: ServerInstalledModSnapshot): JsonObject {
  const resourceSource = projectKnownResourceSource(mod);
  return {
    instanceId: mod.instanceId,
    relativePath: mod.relativePath,
    fileName: truncateText(mod.fileName, maximumRelativePathLength),
    name: truncateText(mod.name, maximumNameLength),
    ...(mod.version ? { version: truncateText(mod.version, maximumVersionLength) } : {}),
    ...(mod.description
      ? { description: truncateText(mod.description, maximumDescriptionLength) }
      : {}),
    addedAt: mod.addedAt,
    disabled: mod.disabled,
    ...(resourceSource ? { resourceSource } : {}),
  };
}

function projectKnownResourceSource(mod: ServerInstalledModSnapshot): JsonObject | undefined {
  const source = mod.resourceSource;
  if (!source || (source.source !== "modrinth" && source.source !== "curseforge")) {
    return undefined;
  }
  return {
    source: source.source,
    id: truncateText(source.id, maximumSourceIdentityLength),
    ...(source.version ? { version: truncateText(source.version, maximumVersionLength) } : {}),
  };
}

function matchesInstalledModQuery(mod: ServerInstalledModSnapshot, query: string): boolean {
  if (!query) return true;
  const searchable = [mod.name, mod.fileName, mod.version ?? ""]
    .join("\n")
    .toLocaleLowerCase("en-US");
  return searchable.includes(query.toLocaleLowerCase("en-US"));
}

function parseInstalledModsQuery(value: JsonValue): InstalledModsQuery {
  const input = expectObject(value, "服务器 Mod 资源", resourceInputProperties);
  return {
    query: readOptionalText(input.query, "query", maximumQueryLength)?.trim() ?? "",
    ...(input.disabled === undefined
      ? {}
      : { disabled: expectBoolean(input.disabled, "disabled") }),
    page: readOptionalInteger(input.page, "page", 1, maximumPage) ?? defaultPage,
    pageSize:
      readOptionalInteger(input.pageSize, "pageSize", 1, maximumPageSize) ?? defaultPageSize,
  };
}

function parseModTargetInput(
  value: JsonValue,
  label: string,
  withDisabled: boolean,
): {
  readonly instanceId: string;
  readonly relativePath: string;
  readonly disabled?: boolean;
} {
  const input = expectObject(
    value,
    label,
    withDisabled ? setDisabledInputProperties : modTargetInputProperties,
  );
  return {
    instanceId: expectInstanceId(input.instanceId),
    relativePath: expectRelativePath(input.relativePath),
    ...(withDisabled ? { disabled: expectBoolean(input.disabled, "disabled") } : {}),
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
  if (typeof value !== "string" || !instanceIdPattern.test(value)) {
    throw new TypeError("服务器实例 ID 不合法");
  }
  return value;
}

function expectRelativePath(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumRelativePathLength ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("Mod relativePath 必须是实例内安全 POSIX 相对路径");
  }
  return value;
}

function expectBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

function readOptionalText(
  value: JsonValue | undefined,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) {
    throw new TypeError(`${label} 必须是长度不超过 ${maximumLength} 且不含空字符的文本`);
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

function expectObjectOutput(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Agent 输出缺少 ${label}`);
  }
  return value;
}

function pageRange(page: number, pageSize: number): string {
  const start = (page - 1) * pageSize + 1;
  return `${start}～${start + pageSize - 1}`;
}

function truncateText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
