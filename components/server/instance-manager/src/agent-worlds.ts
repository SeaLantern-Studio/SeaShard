import type {
  ServerInstanceSnapshot,
  ServerWorldBackupSnapshot,
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
const maximumWorldIdLength = 512;
const maximumWorldNameLength = 200;
const maximumBackupFileNameLength = 512;
const maximumPresentationTextCharacters = 10;
const presentationTextSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const instanceIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u;
const worldTargetInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  worldId: true,
};
const backupTargetInputProperties: Readonly<Record<string, true>> = {
  instanceId: true,
  worldId: true,
  fileName: true,
};
const backupResourceInputProperties: Readonly<Record<string, true>> = {
  page: true,
  pageSize: true,
};

export interface ServerWorldAgentResourceOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  listWorldStorage(instanceId: string): Promise<ServerWorldStorageSnapshot>;
  listWorldBackups(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldBackupSnapshot[]>;
}

export interface ServerWorldAgentToolOptions extends Pick<
  ServerWorldAgentResourceOptions,
  "listWorldStorage" | "listWorldBackups"
> {
  runWhileServerStopped<T>(
    instanceId: string,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  switchWorld(instanceId: string, worldId: string): Promise<ServerWorldStorageSnapshot>;
  createWorldBackup(instanceId: string, worldId: string): Promise<ServerWorldBackupSnapshot>;
  restoreWorldBackup(
    instanceId: string,
    worldId: string,
    fileName: string,
  ): Promise<ServerWorldStorageSnapshot>;
  deleteWorldBackup(instanceId: string, worldId: string, fileName: string): Promise<void>;
}

export interface ServerWorldAgentRegistrationOptions
  extends ServerWorldAgentResourceOptions, ServerWorldAgentToolOptions {}

interface BackupPageQuery {
  readonly page: number;
  readonly pageSize: number;
}

interface WorldTargetInput {
  readonly instanceId: string;
  readonly worldId: string;
}

interface BackupTargetInput extends WorldTargetInput {
  readonly fileName: string;
}

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$",
  description: "目标服务器实例 ID；可先读取 server://instances 获取。",
};
const worldIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumWorldIdLength,
  pattern: "^[^/\\\\]+$",
  description:
    "目标世界 ID；unified 模式使用 worlds 资源中 saves 的 id，split 模式使用 dimensions 的 worldId。",
};
const backupFileNameProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumBackupFileNameLength,
  pattern: "^[^/\\\\]+\\.[zZ][iI][pP]$",
  description: "对应世界备份资源返回的 fileName；只能提交 ZIP 文件名，不能提交路径或自行拼接目录。",
};
const emptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const backupResourceInputSchema: JsonObject = {
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
      description: "每页最多返回的备份数量。",
    },
  },
  additionalProperties: false,
};
const worldTargetInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    worldId: worldIdProperty,
  },
  required: ["instanceId", "worldId"],
  additionalProperties: false,
};
const backupTargetInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    worldId: worldIdProperty,
    fileName: backupFileNameProperty,
  },
  required: ["instanceId", "worldId", "fileName"],
  additionalProperties: false,
};

/** 世界清单和备份清单均来自实例管理器，不向 Agent 发布宿主目录或内嵌图标。 */
export function registerServerWorldAgentResources(
  context: Pick<PluginContext, "agentResources">,
  options: ServerWorldAgentResourceOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/worlds": createServerWorldsResource(options),
    "server://instances/{instanceId}/worlds/{worldId}/backups":
      createServerWorldBackupsResource(options),
  });
}

/**
 * Runtime 持有停机调用的外层实例队列，实例管理器继续负责共享 Gate 和真实文件事务。
 * 这样排队期间的 Invocation 可以取消，所有其他调用入口仍无法绕过停机约束。
 */
export function registerServerWorldAgentTools(
  context: Pick<PluginContext, "agentTool">,
  options: ServerWorldAgentToolOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "switch-world",
      title: "切换服务器世界",
      description:
        "在服务器停机后切换下次启动使用的世界；目标必须来自对应实例的世界资源，不能提交 level-name 或文件路径。",
      confirmationLevel: 1,
      inputSchema: worldTargetInputSchema,
      outputDescription:
        "返回切换前后的当前世界安全投影和 changed；目标已经是当前世界时 changed 为 false。",
      examples: [{ instanceId: "server-1", worldId: "world" }],
    },
    (input, execution) => switchServerWorld(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "create-world-backup",
      title: "创建服务器世界备份",
      description:
        "在服务器停机后为一个明确世界创建 ZIP 备份；目标必须来自对应实例的世界资源，文件名和目录由 Host 生成。",
      confirmationLevel: 1,
      inputSchema: worldTargetInputSchema,
      outputDescription:
        "返回新备份的安全投影，包括实例、世界、文件名、创建时间和文件大小，不包含宿主路径。",
      examples: [{ instanceId: "server-1", worldId: "world" }],
    },
    (input, execution) => createServerWorldBackup(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "restore-world-backup",
      title: "恢复服务器世界备份",
      description:
        "在服务器停机后使用一个明确备份替换目标世界数据；备份文件名必须来自对应世界的备份资源，不能提交路径。",
      confirmationLevel: 2,
      inputSchema: backupTargetInputSchema,
      outputDescription:
        "返回本次使用的备份安全投影，以及恢复完成后重新扫描的最新世界存储安全投影。",
      examples: [
        { instanceId: "server-1", worldId: "world", fileName: "world-20260829-120000.zip" },
      ],
    },
    (input, execution) => restoreServerWorldBackup(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "delete-world-backup",
      title: "删除服务器世界备份",
      description:
        "在服务器停机后永久删除一个明确的世界备份；备份文件名必须来自对应世界的备份资源，不能提交路径。",
      confirmationLevel: 1,
      inputSchema: backupTargetInputSchema,
      outputDescription: "返回删除前的备份安全投影；删除完成后的状态固定为 null。",
      examples: [
        { instanceId: "server-1", worldId: "world", fileName: "world-20260829-120000.zip" },
      ],
    },
    (input, execution) => deleteServerWorldBackup(options, input, execution),
  );
}

/** 测试或同一组件宿主可一次注册完整能力；生产 Host 按领域与 Runtime 生命周期拆分注册。 */
export function registerServerWorldAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerWorldAgentRegistrationOptions,
): void {
  registerServerWorldAgentResources(context, options);
  registerServerWorldAgentTools(context, options);
}

export function createServerWorldsResource(
  options: Pick<ServerWorldAgentResourceOptions, "listInstances" | "listWorldStorage">,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定服务器实例可发现的世界存储布局和可操作世界 ID；unified 模式使用 saves.id，split 模式使用 dimensions.worldId。结果不包含宿主绝对路径或图标 Base64。",
    inputSchema: emptyInputSchema,
    outputDescription:
      "返回存储模式、当前世界、世界存档和分维度分组；每个字段均为实例管理器的安全投影。",
    examples: [{}],
    help: "切换、备份或管理数据包前先读取此资源；split 模式必须使用 dimensions 中的 worldId。",
    presentation: { title: "读取服务器世界" },
    implementation: {
      read: (request, execution) => readServerWorlds(options, request, execution),
      presentRequest: (request) => presentWorldsRequest(options, request),
      presentResult: presentWorldsResult,
    },
  });
}

export function createServerWorldBackupsResource(
  options: ServerWorldAgentResourceOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "按创建时间倒序读取指定服务器世界的 ZIP 备份，支持有界分页；世界和备份身份必须来自已登记实例。",
    inputSchema: backupResourceInputSchema,
    outputDescription:
      "返回最多 50 个备份的安全投影和统一页码分页信息，不包含绝对路径或内部备份目录名称。",
    examples: [
      { page: 1, pageSize: 20 },
      { page: 2, pageSize: 10 },
    ],
    help: "恢复备份使用 server_restore-world-backup；删除备份使用 server_delete-world-backup。",
    presentation: { title: "读取服务器世界备份" },
    implementation: {
      read: (request, execution) => readServerWorldBackups(options, request, execution),
      presentRequest: (request) => presentWorldBackupsRequest(options, request),
      presentResult: presentWorldBackupsResult,
    },
  });
}

async function readServerWorlds(
  options: Pick<ServerWorldAgentResourceOptions, "listWorldStorage">,
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

async function readServerWorldBackups(
  options: Pick<ServerWorldAgentResourceOptions, "listWorldStorage" | "listWorldBackups">,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const worldId = expectWorldId(request.pathParams.worldId);
  const query = parseBackupPageQuery(request.input);
  const storage = await waitForInvocation(options.listWorldStorage(instanceId), execution.signal);
  findWorldForAgent(storage, worldId);
  const backups = await waitForInvocation(
    options.listWorldBackups(instanceId, worldId),
    execution.signal,
  );
  execution.signal?.throwIfAborted();

  const start = (query.page - 1) * query.pageSize;
  const items = backups
    .slice(start, start + query.pageSize)
    .map((backup) => projectWorldBackupForAgent(backup));
  const totalPages = Math.ceil(backups.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      instanceId,
      worldId,
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: backups.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

async function presentWorldsRequest(
  options: Pick<ServerWorldAgentResourceOptions, "listInstances">,
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

async function presentWorldBackupsRequest(
  options: Pick<ServerWorldAgentResourceOptions, "listInstances" | "listWorldStorage">,
  request: AgentResourceReadRequest,
): Promise<readonly AgentActivityPresentationField[]> {
  const query = parseBackupPageQuery(request.input);
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const worldId = expectWorldId(request.pathParams.worldId);
  const [instance, storage] = await Promise.all([
    findInstanceForPresentation(options, instanceId),
    options.listWorldStorage(instanceId),
  ]);
  const world = findWorldForAgent(storage, worldId);
  return [
    { label: "服务器", value: truncatePresentationText(instance.name) },
    { label: "世界", value: truncatePresentationText(world.name) },
    { label: "范围", value: pageRange(query.page, query.pageSize) },
  ];
}

function presentWorldBackupsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const output = expectObjectOutput(result.content, "服务器世界备份资源结果");
  if (!Array.isArray(output.items)) throw new TypeError("服务器世界备份资源结果缺少 items");
  return [{ value: String(output.items.length), unit: "个备份" }];
}

async function switchServerWorld(
  options: ServerWorldAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseWorldTargetInput(value, "server_switch-world");
  return waitForInvocation(
    options.runWhileServerStopped(input.instanceId, "切换服务器世界", async () => {
      execution.signal?.throwIfAborted();
      const beforeStorage = await options.listWorldStorage(input.instanceId);
      const before = findCurrentWorldForAgent(beforeStorage);
      const target = findWorldForAgent(beforeStorage, input.worldId);
      // 世界扫描属于预检；扫描结束后再接受一次取消，避免已取消的调用进入真实写入阶段。
      execution.signal?.throwIfAborted();
      if (target.current) {
        return {
          before: projectWorldIdentity(before),
          after: projectWorldIdentity(target),
          changed: false,
        };
      }
      const afterStorage = await options.switchWorld(input.instanceId, input.worldId);
      const after = findWorldForAgent(afterStorage, input.worldId);
      return {
        before: projectWorldIdentity(before),
        after: projectWorldIdentity(after),
        changed: before?.worldId !== after.worldId,
      };
    }),
    execution.signal,
  );
}

async function createServerWorldBackup(
  options: ServerWorldAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseWorldTargetInput(value, "server_create-world-backup");
  const backup = await waitForInvocation(
    options.runWhileServerStopped(input.instanceId, "创建世界备份", async () => {
      execution.signal?.throwIfAborted();
      const storage = await options.listWorldStorage(input.instanceId);
      findWorldForAgent(storage, input.worldId);
      // 世界存在性检查完成后保留明确的取消落点，后续调用才会创建备份文件。
      execution.signal?.throwIfAborted();
      return options.createWorldBackup(input.instanceId, input.worldId);
    }),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return { backup: projectWorldBackupForAgent(backup) };
}

async function restoreServerWorldBackup(
  options: ServerWorldAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseBackupTargetInput(value, "server_restore-world-backup");
  return waitForInvocation(
    options.runWhileServerStopped(input.instanceId, "恢复世界备份", async () => {
      execution.signal?.throwIfAborted();
      const backup = await findWorldBackup(options, input);
      // 备份存在性检查可能访问磁盘；检查期间收到的取消必须阻止随后的覆盖恢复。
      execution.signal?.throwIfAborted();
      const worlds = await options.restoreWorldBackup(
        input.instanceId,
        input.worldId,
        input.fileName,
      );
      return {
        backup: projectWorldBackupForAgent(backup),
        worlds: projectWorldStorageForAgent(worlds),
      };
    }),
    execution.signal,
  );
}

async function deleteServerWorldBackup(
  options: ServerWorldAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseBackupTargetInput(value, "server_delete-world-backup");
  return waitForInvocation(
    options.runWhileServerStopped(input.instanceId, "删除世界备份", async () => {
      execution.signal?.throwIfAborted();
      const before = await findWorldBackup(options, input);
      // 删除前的最后一个取消窗口位于预检之后，确保取消不会继续进入文件删除。
      execution.signal?.throwIfAborted();
      await options.deleteWorldBackup(input.instanceId, input.worldId, input.fileName);
      return { before: projectWorldBackupForAgent(before), after: null };
    }),
    execution.signal,
  );
}

async function findWorldBackup(
  options: Pick<ServerWorldAgentToolOptions, "listWorldBackups">,
  input: BackupTargetInput,
): Promise<ServerWorldBackupSnapshot> {
  const backup = (await options.listWorldBackups(input.instanceId, input.worldId)).find(
    (candidate) => candidate.fileName === input.fileName,
  );
  if (!backup) {
    throw new Error(
      `服务器实例 ${input.instanceId} 的世界 ${input.worldId} 中不存在备份：${input.fileName}`,
    );
  }
  return backup;
}

export async function findInstanceForPresentation(
  options: Pick<ServerWorldAgentResourceOptions, "listInstances">,
  instanceId: string,
): Promise<ServerInstanceSnapshot> {
  const instance = (await options.listInstances()).find(({ id }) => id === instanceId);
  if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
  return instance;
}

export function findWorldNameForPresentation(
  storage: ServerWorldStorageSnapshot,
  worldId: string,
): string {
  return findWorldForAgent(storage, worldId).name;
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

/** 备份投影只保留可再次提交的文件名和展示元数据。 */
export function projectWorldBackupForAgent(backup: ServerWorldBackupSnapshot): JsonObject {
  return {
    instanceId: backup.instanceId,
    worldId: truncateText(backup.worldId, maximumWorldIdLength),
    fileName: truncateText(backup.fileName, maximumBackupFileNameLength),
    createdAt: backup.createdAt,
    sizeBytes: backup.sizeBytes,
  };
}

function projectWorldSaveForAgent(save: ServerWorldSave): JsonObject {
  const resourceSource = projectKnownResourceSource(save);
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

function projectKnownResourceSource(save: ServerWorldSave): JsonObject | undefined {
  const source = save.resourceSource;
  if (!source || (source.source !== "modrinth" && source.source !== "curseforge")) {
    return undefined;
  }
  return {
    source: source.source,
    id: source.id,
    ...(source.version ? { version: source.version } : {}),
  };
}

function findWorldForAgent(
  storage: ServerWorldStorageSnapshot,
  worldId: string,
): { readonly worldId: string; readonly name: string; readonly current: boolean } {
  const world =
    storage.mode === "unified"
      ? storage.saves.find(({ id }) => id === worldId)
      : storage.dimensions.find(({ id }) => id === worldId);
  if (!world) throw new Error(`服务器实例 ${storage.instanceId} 中不存在世界：${worldId}`);
  return { worldId, name: world.name, current: world.current };
}

function findCurrentWorldForAgent(
  storage: ServerWorldStorageSnapshot,
): { readonly worldId: string; readonly name: string; readonly current: boolean } | null {
  const world =
    storage.mode === "unified"
      ? storage.saves.find(({ current }) => current)
      : storage.dimensions.find(({ current }) => current);
  if (!world) return null;
  return { worldId: world.id, name: world.name, current: true };
}

function projectWorldIdentity(
  world: { readonly worldId: string; readonly name: string; readonly current: boolean } | null,
): JsonObject | null {
  if (!world) return null;
  return {
    worldId: truncateText(world.worldId, maximumWorldIdLength),
    name: truncateText(world.name, maximumWorldNameLength),
    current: world.current,
  };
}

function parseBackupPageQuery(value: JsonValue): BackupPageQuery {
  const object = expectObject(value, "服务器世界备份资源", backupResourceInputProperties);
  return {
    page: readOptionalInteger(object.page, "page", defaultPage, maximumPage),
    pageSize: readOptionalInteger(object.pageSize, "pageSize", defaultPageSize, maximumPageSize),
  };
}

function parseWorldTargetInput(value: JsonValue, label: string): WorldTargetInput {
  const object = expectObject(value, label, worldTargetInputProperties);
  return {
    instanceId: expectInstanceId(object.instanceId),
    worldId: expectWorldId(object.worldId),
  };
}

function parseBackupTargetInput(value: JsonValue, label: string): BackupTargetInput {
  const object = expectObject(value, label, backupTargetInputProperties);
  return {
    instanceId: expectInstanceId(object.instanceId),
    worldId: expectWorldId(object.worldId),
    fileName: expectBackupFileName(object.fileName),
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

function expectObjectOutput(value: JsonValue, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value;
}

function expectEmptyInput(value: JsonValue, label: string): void {
  const object = expectObject(value, label, {});
  if (Object.keys(object).length !== 0) throw new TypeError(`${label}不接受参数`);
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
    value.length === 0 ||
    value.length > maximumWorldIdLength ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new TypeError("服务器世界 ID 必须是末级目录名称");
  }
  return value;
}

function expectBackupFileName(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumBackupFileNameLength ||
    value.includes("/") ||
    value.includes("\\") ||
    !value.toLowerCase().endsWith(".zip")
  ) {
    throw new TypeError("服务器世界备份必须是末级 ZIP 文件名");
  }
  return value;
}

function readOptionalInteger(
  value: JsonValue | undefined,
  field: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
    throw new TypeError(`${field} 必须是 1 到 ${maximum} 之间的整数`);
  }
  return value;
}

function pageRange(page: number, pageSize: number): string {
  const start = (page - 1) * pageSize + 1;
  return `${start}～${start + pageSize - 1}`;
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
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

/** Invocation 取消只停止等待，已经开始的世界事务继续由领域组件结算。 */
async function waitForInvocation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
