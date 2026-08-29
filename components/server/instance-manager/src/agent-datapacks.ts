import type {
  ServerInstanceSnapshot,
  ServerResourceSourceMetadata,
  ServerWorldDatapackSnapshot,
  ServerWorldSave,
  ServerWorldStorageSnapshot,
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
const defaultPageSize = 20;
const maximumPage = 10_000;
const maximumPageSize = 50;
const maximumQueryLength = 200;
const maximumWorldIdLength = 512;
const maximumFileNameLength = 512;
const maximumWorldNameLength = 200;
const maximumPresentationTextCharacters = 10;
const presentationTextSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const maximumDescriptionLength = 1_000;
const maximumSourceIdentityLength = 128;
const instanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

const datapackResourceInputProperties: Readonly<Record<string, true>> = {
  query: true,
  disabled: true,
  page: true,
  pageSize: true,
};
const setDisabledInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  worldId: true,
  fileName: true,
  disabled: true,
};
const datapackTargetInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  worldId: true,
  fileName: true,
};

export interface ServerDatapackAgentResourceOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  listWorldStorage(instanceId: string): Promise<ServerWorldStorageSnapshot>;
  listWorldDatapacks(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldDatapackSnapshot[]>;
}

export interface ServerDatapackAgentToolOptions extends Pick<
  ServerDatapackAgentResourceOptions,
  "listWorldDatapacks"
> {
  runWhileServerStopped<T>(instanceId: string, operation: () => Promise<T>): Promise<T>;
  setWorldDatapackDisabled(
    instanceId: string,
    worldId: string,
    fileName: string,
    disabled: boolean,
  ): Promise<ServerWorldDatapackSnapshot>;
  deleteWorldDatapack(instanceId: string, worldId: string, fileName: string): Promise<void>;
}

export interface ServerDatapackAgentRegistrationOptions
  extends ServerDatapackAgentResourceOptions, ServerDatapackAgentToolOptions {}

interface InstalledDatapacksQuery {
  readonly query: string;
  readonly disabled?: boolean;
  readonly page: number;
  readonly pageSize: number;
}

interface DatapackTargetInput {
  readonly instanceId: string;
  readonly worldId: string;
  readonly fileName: string;
  readonly disabled?: boolean;
}

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  description: "目标服务器实例 ID；可先读取 server://instances 获取。",
};
const worldIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumWorldIdLength,
  pattern: "^[^/\\\\]+$",
  description:
    "目标世界 ID，只能提交实际世界目录的末级名称；unified 模式使用 saves 中的 id，split 模式使用 dimensions 中的 worldId，不能包含外层容器或斜杠。",
};
const fileNameProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumFileNameLength,
  description:
    "server://instances/{instanceId}/worlds/{worldId}/datapacks 返回的文件名；不能提交路径或自行猜测名称。",
};

const emptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const installedDatapacksInputSchema: JsonObject = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: maximumQueryLength,
      default: "",
      description: "按数据包文件名或简介搜索；空字符串返回全部。",
    },
    disabled: {
      type: "boolean",
      description: "只返回已禁用或已启用的数据包；省略时返回全部。",
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
      description: "每页最多返回的数据包数量。",
    },
  },
  additionalProperties: false,
};
const setDatapackDisabledInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    worldId: worldIdProperty,
    fileName: fileNameProperty,
    disabled: {
      type: "boolean",
      description:
        "true 写入 Minecraft level.dat 的原生禁用列表；false 写入原生启用列表。数据包文件名保持不变。",
    },
  },
  required: ["instanceId", "worldId", "fileName", "disabled"],
  additionalProperties: false,
};
const deleteDatapackInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    worldId: worldIdProperty,
    fileName: fileNameProperty,
  },
  required: ["instanceId", "worldId", "fileName"],
  additionalProperties: false,
};

/**
 * 世界和已安装数据包都由实例管理器扫描；资源只发布可操作身份和安全元数据。
 * split 存储下数据包属于逻辑世界组，因此 dimensions 中额外发布可直接提交的 worldId。
 */
export function registerServerDatapackAgentResources(
  context: Pick<PluginContext, "agentResources">,
  options: ServerDatapackAgentResourceOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/worlds": createServerWorldsResource(options),
    "server://instances/{instanceId}/worlds/{worldId}/datapacks":
      createServerInstalledDatapacksResource(options),
  });
}

/**
 * Runtime 用实例级互斥区间包住世界文件事务；实例管理器继续拥有实际文件读写。
 * 这样启动操作只能在数据包事务完成后继续，同时保持 Runtime→Instance Manager 的单向依赖。
 */
export function registerServerDatapackAgentTools(
  context: Pick<PluginContext, "agentTool">,
  options: ServerDatapackAgentToolOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "set-datapack-disabled",
      title: "设置服务器数据包启用状态",
      description:
        "在服务器停机后，通过世界 level.dat 的 Minecraft 原生 DataPacks 列表启用或禁用一个数据包；文件名保持不变。目标必须来自对应世界的数据包资源。",
      confirmationLevel: 1,
      inputSchema: setDatapackDisabledInputSchema,
      outputDescription:
        "返回操作前后重新读取的数据包安全投影；fileName 保持不变，disabled 反映 level.dat 中的原生状态。",
      examples: [
        {
          instanceId: "server-1",
          worldId: "world",
          fileName: "example-datapack.zip",
          disabled: true,
        },
      ],
    },
    (input, execution) => setServerDatapackDisabled(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "delete-datapack",
      title: "删除服务器数据包",
      description:
        "在服务器停机后，删除指定世界中的一个已安装数据包，并同步清理对应的资源来源记录；目标必须来自对应世界的数据包资源。",
      confirmationLevel: 1,
      inputSchema: deleteDatapackInputSchema,
      outputDescription: "返回删除前的数据包安全投影；删除完成后的状态固定为 null。",
      examples: [
        {
          instanceId: "server-1",
          worldId: "world",
          fileName: "example-datapack.zip",
        },
      ],
    },
    (input, execution) => deleteServerDatapack(options, input, execution),
  );
}

/** 测试或同一组件宿主可一次注册完整能力；生产 Host 分别由实例管理器和运行组件注册。 */
export function registerServerDatapackAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerDatapackAgentRegistrationOptions,
): void {
  registerServerDatapackAgentResources(context, options);
  registerServerDatapackAgentTools(context, options);
}

export function createServerWorldsResource(
  options: Pick<ServerDatapackAgentResourceOptions, "listInstances" | "listWorldStorage">,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定服务器实例可发现的世界存储布局和可操作世界 ID；unified 模式使用 saves.id，split 模式使用 dimensions.worldId。结果不包含宿主绝对路径或图标 Base64。",
    inputSchema: emptyInputSchema,
    outputDescription:
      "返回存储模式、当前世界、世界存档和分维度分组；每个字段均为实例管理器的安全投影。",
    examples: [{}],
    help: "安装或管理数据包前先读取此资源；split 模式必须使用 dimensions 中的 worldId。",
    presentation: { title: "读取服务器世界" },
    implementation: {
      read: (request, execution) => readServerWorlds(options, request, execution),
      presentRequest: (request) => presentWorldsRequest(options, request),
      presentResult: presentWorldsResult,
    },
  });
}

export function createServerInstalledDatapacksResource(
  options: ServerDatapackAgentResourceOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定服务器世界中已安装的数据包，支持文件名、简介、启用状态和有界分页；结果不包含宿主绝对路径、图标 Base64 或远程图标地址。",
    inputSchema: installedDatapacksInputSchema,
    outputDescription: "返回最多 50 个数据包的安全投影和统一页码分页信息。",
    examples: [
      { query: "vanilla tweaks", page: 1, pageSize: 20 },
      { disabled: true, page: 1, pageSize: 20 },
    ],
    help: "启停使用 server_set-datapack-disabled；删除使用 server_delete-datapack。",
    presentation: { title: "读取服务器数据包" },
    implementation: {
      read: (request, execution) => readServerInstalledDatapacks(options, request, execution),
      presentRequest: (request) => presentInstalledDatapacksRequest(options, request),
      presentResult: presentInstalledDatapacksResult,
    },
  });
}

async function readServerWorlds(
  options: Pick<ServerDatapackAgentResourceOptions, "listWorldStorage">,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  expectEmptyInput(request.input, "服务器世界资源");
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const storage = await waitForInvocation(options.listWorldStorage(instanceId), execution.signal);
  execution.signal?.throwIfAborted();
  return {
    mimeType: "application/json",
    content: projectWorldStorageForAgent(storage),
  };
}

async function readServerInstalledDatapacks(
  options: Pick<ServerDatapackAgentResourceOptions, "listWorldDatapacks">,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const worldId = expectWorldId(request.pathParams.worldId);
  const query = parseInstalledDatapacksQuery(request.input);
  const datapacks = (
    await waitForInvocation(options.listWorldDatapacks(instanceId, worldId), execution.signal)
  ).filter(
    (datapack) =>
      (query.disabled === undefined || datapack.disabled === query.disabled) &&
      matchesInstalledDatapackQuery(datapack, query.query),
  );
  execution.signal?.throwIfAborted();

  const start = (query.page - 1) * query.pageSize;
  const items = datapacks
    .slice(start, start + query.pageSize)
    .map((datapack) => projectInstalledDatapackForAgent(datapack));
  const totalPages = Math.ceil(datapacks.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      instanceId,
      worldId,
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: datapacks.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

async function presentWorldsRequest(
  options: Pick<ServerDatapackAgentResourceOptions, "listInstances">,
  request: AgentResourceReadRequest,
): Promise<readonly AgentActivityPresentationField[]> {
  expectEmptyInput(request.input, "服务器世界资源");
  const instance = await findInstanceForPresentation(
    options,
    expectInstanceId(request.pathParams.instanceId),
  );
  return [{ label: "服务器", value: truncatePresentationText(instance.name) }];
}

function presentWorldsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const output = expectObjectOutput(result.content, "服务器世界资源结果");
  if (!Array.isArray(output.saves) || !Array.isArray(output.dimensions)) {
    throw new TypeError("服务器世界资源结果缺少 saves 或 dimensions");
  }
  const count = output.mode === "split" ? output.dimensions.length : output.saves.length;
  return [{ value: String(count), unit: "个世界" }];
}

async function presentInstalledDatapacksRequest(
  options: Pick<ServerDatapackAgentResourceOptions, "listInstances" | "listWorldStorage">,
  request: AgentResourceReadRequest,
): Promise<readonly AgentActivityPresentationField[]> {
  const query = parseInstalledDatapacksQuery(request.input);
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const worldId = expectWorldId(request.pathParams.worldId);
  const [instance, storage] = await Promise.all([
    findInstanceForPresentation(options, instanceId),
    options.listWorldStorage(instanceId),
  ]);
  const worldName = findWorldNameForPresentation(storage, worldId);
  return [
    { label: "服务器", value: truncatePresentationText(instance.name) },
    { label: "世界", value: truncatePresentationText(worldName) },
    { label: "范围", value: pageRange(query.page, query.pageSize) },
    ...(query.query ? [{ label: "搜索", value: truncatePresentationText(query.query) }] : []),
    ...(query.disabled === undefined
      ? []
      : [{ label: "状态", value: query.disabled ? "已禁用" : "已启用" }]),
  ];
}

async function findInstanceForPresentation(
  options: Pick<ServerDatapackAgentResourceOptions, "listInstances">,
  instanceId: string,
): Promise<ServerInstanceSnapshot> {
  const instance = (await options.listInstances()).find(({ id }) => id === instanceId);
  if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
  return instance;
}

function findWorldNameForPresentation(
  storage: ServerWorldStorageSnapshot,
  worldId: string,
): string {
  const world =
    storage.mode === "unified"
      ? storage.saves.find(({ id }) => id === worldId)
      : storage.dimensions.find(({ id }) => id === worldId);
  if (!world) throw new Error(`服务器实例 ${storage.instanceId} 中不存在世界：${worldId}`);
  return world.name;
}

function presentInstalledDatapacksResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const output = expectObjectOutput(result.content, "服务器数据包资源结果");
  if (!Array.isArray(output.items)) throw new TypeError("服务器数据包资源结果缺少 items");
  return [{ value: String(output.items.length), unit: "个数据包" }];
}

async function setServerDatapackDisabled(
  options: ServerDatapackAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseDatapackTargetInput(value, "server_set-datapack-disabled", true);
  const before = await findInstalledDatapack(options, input, execution.signal);
  // 回调取得 Runtime 的实例互斥权后再次检查 Invocation，取消排队中的调用不会延迟执行写事务。
  const after = await waitForInvocation(
    options.runWhileServerStopped(input.instanceId, async () => {
      execution.signal?.throwIfAborted();
      return options.setWorldDatapackDisabled(
        input.instanceId,
        input.worldId,
        input.fileName,
        input.disabled!,
      );
    }),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return {
    before: projectInstalledDatapackForAgent(before),
    after: projectInstalledDatapackForAgent(after),
  };
}

async function deleteServerDatapack(
  options: ServerDatapackAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseDatapackTargetInput(value, "server_delete-datapack", false);
  const before = await findInstalledDatapack(options, input, execution.signal);
  await waitForInvocation(
    options.runWhileServerStopped(input.instanceId, async () => {
      execution.signal?.throwIfAborted();
      return options.deleteWorldDatapack(input.instanceId, input.worldId, input.fileName);
    }),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return { before: projectInstalledDatapackForAgent(before), after: null };
}

async function findInstalledDatapack(
  options: Pick<ServerDatapackAgentResourceOptions, "listWorldDatapacks">,
  input: DatapackTargetInput,
  signal?: AbortSignal,
): Promise<ServerWorldDatapackSnapshot> {
  const datapacks = await waitForInvocation(
    options.listWorldDatapacks(input.instanceId, input.worldId),
    signal,
  );
  const datapack = datapacks.find((candidate) => candidate.fileName === input.fileName);
  if (!datapack) {
    throw new Error(
      `服务器实例 ${input.instanceId} 的世界 ${input.worldId} 中不存在数据包：${input.fileName}`,
    );
  }
  return datapack;
}

/** 世界投影保留逻辑 ID、维度关系和当前状态，隐藏宿主路径与内嵌图标。 */
export function projectWorldStorageForAgent(storage: ServerWorldStorageSnapshot): JsonObject {
  return {
    instanceId: storage.instanceId,
    mode: storage.mode,
    ...(storage.currentId ? { currentId: storage.currentId } : {}),
    saves: storage.saves.map((save) => projectWorldSaveForAgent(save)),
    dimensions: storage.dimensions.map((group) => ({
      worldId: truncateText(group.id, maximumWorldIdLength),
      name: truncateText(group.name, maximumWorldNameLength),
      current: group.current,
      saves: group.saves.map((save) => projectWorldSaveForAgent(save)),
    })),
  };
}

function projectWorldSaveForAgent(save: ServerWorldSave): JsonObject {
  const resourceSource = projectKnownResourceSource(save.resourceSource);
  return {
    id: truncateText(save.id, maximumWorldIdLength),
    groupId: truncateText(save.groupId, maximumWorldIdLength),
    name: truncateText(save.name, maximumWorldNameLength),
    dimension: save.dimension,
    current: save.current,
    ...(save.createdAt ? { createdAt: save.createdAt } : {}),
    ...(save.updatedAt ? { updatedAt: save.updatedAt } : {}),
    ...(resourceSource ? { resourceSource } : {}),
  };
}

/** 数据包投影保留原生启用状态和可操作文件名，隐藏绝对路径、内嵌图标与远程图标。 */
export function projectInstalledDatapackForAgent(
  datapack: ServerWorldDatapackSnapshot,
): JsonObject {
  const resourceSource = projectKnownResourceSource(datapack.resourceSource);
  return {
    instanceId: datapack.instanceId,
    worldId: datapack.worldId,
    fileName: truncateText(datapack.fileName, maximumFileNameLength),
    kind: datapack.kind,
    disabled: datapack.disabled,
    ...(datapack.description
      ? { description: truncateText(datapack.description, maximumDescriptionLength) }
      : {}),
    updatedAt: datapack.updatedAt,
    ...(resourceSource ? { resourceSource } : {}),
  };
}

function projectKnownResourceSource(
  source: ServerResourceSourceMetadata | undefined,
): JsonObject | undefined {
  if (!source || (source.source !== "modrinth" && source.source !== "curseforge")) {
    return undefined;
  }
  return {
    source: source.source,
    id: truncateText(source.id, maximumSourceIdentityLength),
    ...(source.version ? { version: truncateText(source.version, maximumDescriptionLength) } : {}),
  };
}

function matchesInstalledDatapackQuery(
  datapack: ServerWorldDatapackSnapshot,
  query: string,
): boolean {
  if (!query) return true;
  return [datapack.fileName, datapack.description ?? ""]
    .join("\n")
    .toLocaleLowerCase("en-US")
    .includes(query.toLocaleLowerCase("en-US"));
}

function parseInstalledDatapacksQuery(value: JsonValue): InstalledDatapacksQuery {
  const input = expectObject(value, "服务器数据包资源", datapackResourceInputProperties);
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

function parseDatapackTargetInput(
  value: JsonValue,
  label: string,
  withDisabled: boolean,
): DatapackTargetInput {
  const input = expectObject(
    value,
    label,
    withDisabled ? setDisabledInputProperties : datapackTargetInputProperties,
  );
  return {
    instanceId: expectInstanceId(input.instanceId),
    worldId: expectWorldId(input.worldId),
    fileName: expectDatapackFileName(input.fileName),
    ...(withDisabled ? { disabled: expectBoolean(input.disabled, "disabled") } : {}),
  };
}

function expectEmptyInput(value: JsonValue, label: string): void {
  expectObject(value, label, {});
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

function expectWorldId(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumWorldIdLength ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError("世界 ID 不合法");
  }
  return value;
}

function expectDatapackFileName(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumFileNameLength ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError("数据包文件名不合法");
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

/** Payload 文本按用户可见字符截断，组合字符和复合 Emoji 不会被拆开。 */
function truncatePresentationText(value: string): string {
  let characterCount = 0;
  for (const segment of presentationTextSegmenter.segment(value)) {
    if (characterCount === maximumPresentationTextCharacters) {
      return `${value.slice(0, segment.index)}…`;
    }
    characterCount += 1;
  }
  return value;
}

/** Invocation 取消只停止等待，已经开始的 level.dat 或文件事务继续由领域组件结算。 */
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
