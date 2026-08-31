import type {
  PluginMarketInstallationSnapshot,
  PluginMarketInstallRequest,
  PluginMarketPlugin,
  PluginMarketRelease,
  PluginMarketSearchRequest,
  PluginMarketSearchResult,
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

const defaultPage = 1;
const defaultPageSize = 10;
const maximumPage = 10_000;
const maximumPageSize = 20;
const maximumQueryLength = 100;
const maximumReleaseCount = 10;
const maximumVersionLength = 100;
const maximumNameLength = 200;
const maximumSummaryLength = 1_000;
const maximumOwnerCount = 20;
const maximumOwnerLength = 100;
const maximumMetadataLength = 200;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const resourceInputProperties: Readonly<Record<string, true>> = {
  query: true,
  page: true,
  pageSize: true,
  refresh: true,
};
const installInputProperties: Readonly<Record<string, true>> = {
  pluginId: true,
  version: true,
};

export interface PluginMarketAgentRegistrationOptions {
  search(request: PluginMarketSearchRequest): Promise<PluginMarketSearchResult>;
  listInstalled(): Promise<readonly PluginMarketInstallationSnapshot[]>;
  install(request: PluginMarketInstallRequest): Promise<PluginMarketInstallationSnapshot>;
}

interface PluginMarketQuery {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly refresh: boolean;
}

const pluginIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$",
  description: "官方 Registry 插件 ID；可先读取 plugin://market 获取。",
};

const pluginMarketInputSchema: JsonObject = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: maximumQueryLength,
      default: "",
      description: "按插件 ID、名称、简介或 Owner 搜索；空字符串列出全部插件。",
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
      description: "每页最多返回的插件数量。",
    },
    refresh: {
      type: "boolean",
      default: false,
      description: "true 时忽略 Catalog 缓存并显式刷新；普通查询应保持 false。",
    },
  },
  additionalProperties: false,
};

const installInputSchema: JsonObject = {
  type: "object",
  properties: {
    pluginId: pluginIdProperty,
    version: {
      type: "string",
      minLength: 1,
      maxLength: maximumVersionLength,
      description: "plugin://market 返回的完整且未撤回版本号。",
    },
  },
  required: ["pluginId", "version"],
  additionalProperties: false,
};

/**
 * Market 组件拥有官方 Catalog 读取与受信 Release 安装能力。
 * Agent 只提交 Registry 主键；下载地址、摘要和完整机器权限确认始终由 Host 与权限网关决定。
 */
export function registerPluginMarketAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: PluginMarketAgentRegistrationOptions,
): void {
  context.agentResources({
    "plugin://market": createPluginMarketResource(options),
  });

  context.agentTool(
    {
      namespace: "plugin",
      name: "install",
      title: "安装第三方插件",
      description:
        "从 SeaShard 官方 Registry 安装指定插件版本；若本地已有该插件，则立即返回当前本地状态，不下载、不更新且不改变启用状态。未安装时，Controller 会重新解析受信 Release 并校验归档与包摘要。",
      confirmationLevel: 2,
      inputSchema: installInputSchema,
      outputDescription:
        "返回安装操作前后的安全状态；before 为 null 表示此前未安装，前后相同表示本地已经安装。结果不包含下载地址、摘要、归档内容或宿主路径。",
      examples: [{ pluginId: "example.backup", version: "1.2.0" }],
    },
    (input, execution) => installPluginRelease(options, input, execution),
  );
}

export function createPluginMarketResource(
  options: PluginMarketAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "搜索 SeaShard 官方插件 Registry，并关联当前安装状态；结果有界且不包含下载地址、Release URL、归档摘要、包摘要或宿主路径。Catalog 网络请求有 30 秒硬超时，Invocation 取消时停止等待共享请求。",
    inputSchema: pluginMarketInputSchema,
    outputDescription:
      "返回最多 20 个插件，每个插件最多 10 个 Catalog 顺序中的 Release，以及分页和 Catalog 获取时间。",
    examples: [
      { query: "backup", page: 1, pageSize: 10, refresh: false },
      { query: "", page: 1, pageSize: 10, refresh: true },
    ],
    help: "安装使用 plugin_install；启停和卸载已安装插件分别使用 plugin_set-enabled 与 plugin_uninstall。",
    presentation: { title: "搜索插件市场" },
    implementation: {
      read: (request, execution) => readPluginMarket(options, request, execution),
      presentRequest: presentPluginMarketRequest,
      presentResult: presentPluginMarketResult,
    },
  });
}

async function readPluginMarket(
  options: PluginMarketAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const query = parsePluginMarketQuery(request.input);
  const [result, installed] = await waitForInvocation(
    Promise.all([options.search(query), options.listInstalled()]),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  return {
    mimeType: "application/json",
    content: {
      plugins: result.plugins.map((plugin) =>
        projectMarketPlugin(plugin, installedById.get(plugin.id)),
      ),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.totalCount,
        totalPages: Math.ceil(result.totalCount / result.pageSize),
        hasMore: result.page * result.pageSize < result.totalCount,
      },
      fetchedAt: result.fetchedAt,
    },
  };
}

function presentPluginMarketRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parsePluginMarketQuery(request.input);
  return [
    { value: query.query || "全部插件" },
    {
      label: "范围",
      value: `${(query.page - 1) * query.pageSize + 1}～${query.page * query.pageSize}`,
    },
    ...(query.refresh ? [{ label: "Catalog", value: "强制刷新" }] : []),
  ];
}

function presentPluginMarketResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const content = expectOutputObject(result.content, "市场资源结果");
  if (!Array.isArray(content.plugins)) throw new TypeError("Agent 市场资源结果缺少 plugins");
  return [{ value: String(content.plugins.length), unit: "个插件" }];
}

async function installPluginRelease(
  options: PluginMarketAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseInstallInput(value);
  const current = (await options.listInstalled()).find((plugin) => plugin.id === input.pluginId);
  execution.signal?.throwIfAborted();
  const before = current === undefined ? null : projectMarketInstallation(current);

  // 本地已有插件时保持版本与启用状态，Agent 可通过相同的 before/after 明确识别“已经安装”。
  if (current) return { before, after: projectMarketInstallation(current) };

  // 二级权限确认由 Agent Runtime 在进入处理函数前完成；这里把确认事实传给现有安装事务。
  const installed = await options.install({
    pluginId: input.pluginId,
    version: input.version,
    acknowledgeFullMachineAccess: true,
  });
  execution.signal?.throwIfAborted();
  return {
    before,
    after: projectMarketInstallation(installed),
  };
}

/** Catalog 投影保留发现和兼容信息，剥离全部安装地址、摘要以及 Release 跳转链接。 */
function projectMarketPlugin(
  plugin: PluginMarketPlugin,
  installation: PluginMarketInstallationSnapshot | undefined,
): JsonObject {
  const usableReleases = plugin.releases.filter((release) => isAgentUsableVersion(release.version));
  const releases = usableReleases
    .slice(0, maximumReleaseCount)
    .map((release) => projectMarketRelease(release));
  return {
    id: plugin.id,
    name: truncateText(plugin.name, maximumNameLength),
    summary: truncateText(plugin.summary, maximumSummaryLength),
    owners: plugin.owners
      .slice(0, maximumOwnerCount)
      .map((owner) => truncateText(owner, maximumOwnerLength)),
    ownersTruncated: plugin.owners.length > maximumOwnerCount,
    repository: truncateText(plugin.source.repository, maximumMetadataLength),
    license: truncateText(plugin.license, maximumMetadataLength),
    releases,
    releaseCount: plugin.releases.length,
    omittedReleaseCount: plugin.releases.length - releases.length,
    installation: installation === undefined ? null : projectMarketInstallation(installation),
  };
}

function projectMarketRelease(release: PluginMarketRelease): JsonObject {
  const runtimes = [...new Set(release.entries.map((entry) => entry.runtime))];
  const executionLocations = [
    ...new Set(
      release.entries.map((entry) =>
        entry.runtime === "client" ? "controller" : (entry.execution ?? "controller"),
      ),
    ),
  ];
  return {
    version: release.version,
    publisher: release.publisher,
    compatibility: {
      seaShard: truncateText(release.compatibility.seaShard, maximumMetadataLength),
      ...(release.compatibility.clientProtocol === undefined
        ? {}
        : {
            clientProtocol: truncateText(
              release.compatibility.clientProtocol,
              maximumMetadataLength,
            ),
          }),
    },
    entryCount: release.entries.length,
    runtimes,
    executionLocations,
    yanked: release.yanked,
  };
}

function projectMarketInstallation(installation: PluginMarketInstallationSnapshot): JsonObject {
  return {
    id: installation.id,
    version: installation.version,
    source: installation.source,
    enabled: installation.enabled,
  };
}

function parsePluginMarketQuery(value: JsonValue): PluginMarketQuery {
  const input = expectObject(value, "插件市场资源", resourceInputProperties);
  return {
    query: readOptionalQuery(input.query) ?? "",
    page: readOptionalInteger(input.page, "page", 1, maximumPage) ?? defaultPage,
    pageSize:
      readOptionalInteger(input.pageSize, "pageSize", 1, maximumPageSize) ?? defaultPageSize,
    refresh: readOptionalBoolean(input.refresh, "refresh") ?? false,
  };
}

function parseInstallInput(value: JsonValue): {
  readonly pluginId: string;
  readonly version: string;
} {
  const input = expectObject(value, "plugin_install", installInputProperties);
  return {
    pluginId: expectPluginId(input.pluginId),
    version: expectVersion(input.version),
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

function expectPluginId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !pluginIdPattern.test(value)) {
    throw new TypeError("插件 ID 必须是有效的 Registry ID");
  }
  return value;
}

function expectVersion(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !isAgentUsableVersion(value)) {
    throw new TypeError("插件版本必须是长度不超过 100 且不含空字符的非空文本");
  }
  return value;
}

function isAgentUsableVersion(value: string): boolean {
  return Boolean(value.trim()) && value.length <= maximumVersionLength && !value.includes("\0");
}

function readOptionalQuery(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumQueryLength || value.includes("\0")) {
    throw new TypeError("市场查询必须是长度不超过 100 且不含空字符的文本");
  }
  return value.trim();
}

function readOptionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
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

function truncateText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

/** 当前 Invocation 可停止等待共享 Catalog 请求；底层 30 秒请求继续服务其他调用并填充缓存。 */
async function waitForInvocation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function expectOutputObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Agent 输出缺少 ${label}`);
  }
  return value;
}
