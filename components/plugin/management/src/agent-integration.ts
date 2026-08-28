import type { PluginManagementEntrySnapshot, PluginManagementSnapshot } from "@seashard/contracts";
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
const maximumProjectedEntryCount = 50;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const pluginSources = ["installed", "development"] as const;
const resourceInputProperties: Readonly<Record<string, true>> = {
  page: true,
  pageSize: true,
  enabled: true,
  source: true,
};
const setEnabledInputProperties: Readonly<Record<string, true>> = {
  pluginId: true,
  enabled: true,
};
const pluginIdInputProperties: Readonly<Record<string, true>> = {
  pluginId: true,
};

export interface PluginManagementAgentRegistrationOptions {
  list(): Promise<readonly PluginManagementSnapshot[]>;
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginManagementSnapshot>;
  uninstall(pluginId: string): Promise<void>;
}

interface InstalledPluginsQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly enabled?: boolean;
  readonly source?: (typeof pluginSources)[number];
}

const pluginIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$",
  description: "第三方插件 Manifest ID；可先读取 plugin://installed 获取。",
};

const installedPluginsInputSchema: JsonObject = {
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
      description: "每页最多返回的第三方插件数量。",
    },
    enabled: {
      type: "boolean",
      description: "只返回已启用或已禁用的插件。",
    },
    source: {
      type: "string",
      enum: [...pluginSources],
      description: "只返回正式安装或开发覆盖来源的插件。",
    },
  },
  additionalProperties: false,
};

const setEnabledInputSchema: JsonObject = {
  type: "object",
  properties: {
    pluginId: pluginIdProperty,
    enabled: {
      type: "boolean",
      description: "true 启用插件全部自动 Binding；false 禁用并等待 Runtime 收敛。",
    },
  },
  required: ["pluginId", "enabled"],
  additionalProperties: false,
};

const uninstallInputSchema: JsonObject = {
  type: "object",
  properties: { pluginId: pluginIdProperty },
  required: ["pluginId"],
  additionalProperties: false,
};

/**
 * 插件管理组件只发布 Kernel 已登记的第三方插件，并复用设置页面使用的启停与卸载事务。
 * Runtime ID、摘要、uses 和原始错误留在领域内部，避免把宿主实现信息送入模型上下文。
 */
export function registerPluginManagementAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: PluginManagementAgentRegistrationOptions,
): void {
  context.agentResources({
    "plugin://installed": createInstalledPluginsResource(options),
  });

  context.agentTool(
    {
      namespace: "plugin",
      name: "set-enabled",
      title: "设置插件启用状态",
      description: "启用或禁用一个已登记第三方插件的全部自动 Binding，并等待 Runtime 完成收敛。",
      confirmationLevel: 1,
      inputSchema: setEnabledInputSchema,
      outputDescription: "返回操作前后的插件安全运行投影；前后相同表示状态已经满足要求。",
      examples: [{ pluginId: "example.backup", enabled: false }],
    },
    (input, execution) => setPluginEnabled(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "plugin",
      name: "uninstall",
      title: "卸载第三方插件",
      description:
        "卸载一个正式安装的第三方插件，停止其 Runtime，并删除全部已安装版本、自动 Binding 和摘要信任记录；开发覆盖不能卸载。",
      confirmationLevel: 1,
      inputSchema: uninstallInputSchema,
      outputDescription: "返回卸载前的插件安全运行投影；卸载完成后的状态固定为 null。",
      examples: [{ pluginId: "example.backup" }],
    },
    (input, execution) => uninstallPlugin(options, input, execution),
  );
}

export function createInstalledPluginsResource(
  options: PluginManagementAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取 SeaShard 当前采用的第三方插件及 Entry 运行状态，支持来源、启用状态和有界分页；结果不包含摘要、Runtime ID、uses、宿主路径或原始错误正文。",
    inputSchema: installedPluginsInputSchema,
    outputDescription: "返回插件安全投影和分页信息，每页最多 50 个插件，每个插件最多 50 个 Entry。",
    examples: [
      { page: 1, pageSize: 20 },
      { enabled: false, source: "installed" },
    ],
    help: "启停插件使用 plugin_set-enabled；卸载正式安装插件使用 plugin_uninstall。",
    presentation: { title: "读取已安装插件" },
    implementation: {
      read: (request, execution) => readInstalledPlugins(options, request, execution),
      presentRequest: presentInstalledPluginsRequest,
      presentResult: presentInstalledPluginsResult,
    },
  });
}

async function readInstalledPlugins(
  options: PluginManagementAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const query = parseInstalledPluginsQuery(request.input);
  const plugins = (await options.list()).filter(
    (plugin) =>
      isPluginId(plugin.id) &&
      (query.enabled === undefined || plugin.enabled === query.enabled) &&
      (query.source === undefined || plugin.source === query.source),
  );
  execution.signal?.throwIfAborted();

  const start = (query.page - 1) * query.pageSize;
  const items = plugins
    .slice(start, start + query.pageSize)
    .map((plugin) => projectManagedPlugin(plugin));
  const totalPages = Math.ceil(plugins.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: plugins.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

function presentInstalledPluginsRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseInstalledPluginsQuery(request.input);
  return [
    { value: `${(query.page - 1) * query.pageSize + 1}～${query.page * query.pageSize}` },
    ...(query.enabled === undefined
      ? []
      : [{ label: "状态", value: query.enabled ? "已启用" : "已禁用" }]),
    ...(query.source === undefined
      ? []
      : [{ label: "来源", value: query.source === "installed" ? "正式安装" : "开发覆盖" }]),
  ];
}

function presentInstalledPluginsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const content = expectOutputObject(result.content, "插件资源结果");
  if (!Array.isArray(content.items)) throw new TypeError("Agent 插件资源结果缺少 items");
  return [{ value: String(content.items.length), unit: "个插件" }];
}

async function setPluginEnabled(
  options: PluginManagementAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseSetEnabledInput(value);
  const before = await findManagedPlugin(options, input.pluginId);
  execution.signal?.throwIfAborted();

  // 幂等判断和混合 Entry 状态收敛由 Kernel 统一完成，Agent 适配器只记录真实前后状态。
  const after = await options.setEnabled(input.pluginId, input.enabled);
  execution.signal?.throwIfAborted();
  return {
    before: projectManagedPlugin(before),
    after: projectManagedPlugin(after),
  };
}

async function uninstallPlugin(
  options: PluginManagementAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const pluginId = parsePluginIdInput(value, "plugin_uninstall");
  const current = await findManagedPlugin(options, pluginId);
  execution.signal?.throwIfAborted();
  if (current.source === "development") {
    throw new Error(`开发覆盖插件不能卸载：${pluginId}`);
  }

  await options.uninstall(pluginId);
  execution.signal?.throwIfAborted();
  return { before: projectManagedPlugin(current), after: null };
}

async function findManagedPlugin(
  options: PluginManagementAgentRegistrationOptions,
  pluginId: string,
): Promise<PluginManagementSnapshot> {
  const plugin = (await options.list()).find((candidate) => candidate.id === pluginId);
  if (!plugin) throw new Error(`第三方插件不存在：${pluginId}`);
  return plugin;
}

/** 管理投影保留插件与 Entry 的运行语义，隐藏 Kernel 身份、能力明细和原始错误正文。 */
function projectManagedPlugin(plugin: PluginManagementSnapshot): JsonObject {
  const entries = plugin.entries
    .slice(0, maximumProjectedEntryCount)
    .map((entry) => projectManagedEntry(entry));
  return {
    id: plugin.id,
    version: plugin.version,
    publisher: plugin.publisher,
    source: plugin.source,
    trust: plugin.trust,
    installedAt: plugin.installedAt,
    enabled: plugin.enabled,
    entries,
    entryCount: plugin.entries.length,
    omittedEntryCount: plugin.entries.length - entries.length,
    hasFailures: plugin.entries.some((entry) => entry.state === "failed"),
  };
}

function projectManagedEntry(entry: PluginManagementEntrySnapshot): JsonObject {
  return {
    id: entry.id,
    runtime: entry.runtime,
    enabled: entry.enabled,
    state: entry.state,
    hasError: entry.state === "failed",
  };
}

function parseInstalledPluginsQuery(value: JsonValue): InstalledPluginsQuery {
  const input = expectObject(value, "已安装插件资源", resourceInputProperties);
  const enabled = readOptionalBoolean(input.enabled, "enabled");
  const source = readOptionalSource(input.source);
  return {
    page: readOptionalInteger(input.page, "page", 1, maximumPage) ?? defaultPage,
    pageSize:
      readOptionalInteger(input.pageSize, "pageSize", 1, maximumPageSize) ?? defaultPageSize,
    ...(enabled === undefined ? {} : { enabled }),
    ...(source === undefined ? {} : { source }),
  };
}

function parseSetEnabledInput(value: JsonValue): {
  readonly pluginId: string;
  readonly enabled: boolean;
} {
  const input = expectObject(value, "plugin_set-enabled", setEnabledInputProperties);
  return {
    pluginId: expectPluginId(input.pluginId),
    enabled: expectBoolean(input.enabled, "enabled"),
  };
}

function parsePluginIdInput(value: JsonValue, label: string): string {
  const input = expectObject(value, label, pluginIdInputProperties);
  return expectPluginId(input.pluginId);
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

function expectPluginId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !isPluginId(value)) {
    throw new TypeError("插件 ID 必须是有效的 Manifest ID");
  }
  return value;
}

function isPluginId(value: string): boolean {
  return pluginIdPattern.test(value);
}

function expectBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

function readOptionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  return value === undefined ? undefined : expectBoolean(value, label);
}

function readOptionalSource(
  value: JsonValue | undefined,
): (typeof pluginSources)[number] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !pluginSources.includes(value as (typeof pluginSources)[number])
  ) {
    throw new TypeError("插件 source 无效");
  }
  return value as (typeof pluginSources)[number];
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
