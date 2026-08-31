import type {
  ServerCoreDownloadTaskSnapshot,
  ServerCoreManagedDownloadResult,
  ServerInstanceSnapshot,
} from "@seashard/contracts";
import {
  type AgentToolExecutionContext,
  type JsonObject,
  type JsonValue,
  type PluginContext,
} from "@seashard/plugin-sdk";
import { projectServerForAgent } from "./agent-resources";
import type { CreateManagedServerInstanceRequest } from "./types";

const maximumIdentityLength = 128;
const maximumArtifactFileNameLength = 512;
const maximumInstanceNameLength = 200;
const instanceIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u;

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$",
  description: "目标服务器实例 ID；必须来自 server://instances。",
};

const catalogIdentityProperty = (description: string): JsonObject => ({
  type: "string",
  minLength: 1,
  maxLength: maximumIdentityLength,
  pattern: "^[^/\\\\]+$",
  description,
});

const createInstanceInputSchema: JsonObject = {
  type: "object",
  properties: {
    serverType: catalogIdentityProperty("server://core-types 返回的核心类型 ID。"),
    gameVersion: catalogIdentityProperty("核心版本资源返回的 Minecraft 版本。"),
    artifactFileName: {
      type: "string",
      minLength: 5,
      maxLength: maximumArtifactFileNameLength,
      pattern: "^[^/\\\\]+\\.[jJ][aA][rR]$",
      description: "核心产物资源返回的稳定 JAR 文件名；不能提交路径或下载地址。",
    },
  },
  required: ["serverType", "gameVersion", "artifactFileName"],
  additionalProperties: false,
};

const renameInstanceInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    name: {
      type: "string",
      minLength: 1,
      maxLength: maximumInstanceNameLength,
      pattern: "^(?!.*[\\u0000-\\u001F\\u007F]).*\\S.*$",
      description: "新的实例显示名称；Host 会去除首尾空白，并按 Unicode 兼容形式和大小写检查重名。",
    },
  },
  required: ["instanceId", "name"],
  additionalProperties: false,
};

const deleteInstanceInputSchema: JsonObject = {
  type: "object",
  properties: { instanceId: instanceIdProperty },
  required: ["instanceId"],
  additionalProperties: false,
};

export interface ServerInstanceAgentToolOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  getDefaultDownloadConnections(): Promise<number>;
  createManaged(
    request: CreateManagedServerInstanceRequest,
  ): Promise<ServerCoreManagedDownloadResult>;
  waitForManagedTask(taskId: string): Promise<void>;
  snapshotManagedTask(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  rename(instanceId: string, name: string): Promise<ServerInstanceSnapshot>;
  delete(instanceId: string): Promise<void>;
}

interface CreateInstanceInput {
  readonly serverType: string;
  readonly gameVersion: string;
  readonly artifactFileName: string;
}

interface RenameInstanceInput {
  readonly instanceId: string;
  readonly name: string;
}

/**
 * 实例创建、重命名和删除都由 Instance Manager 负责真实事务。
 * Agent 只提交核心目录身份或已登记实例 ID，不获得托管根目录和清单路径。
 */
export function registerServerInstanceAgentTools(
  context: Pick<PluginContext, "agentTool">,
  options: ServerInstanceAgentToolOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "create-instance",
      title: "创建托管服务器实例",
      description:
        "使用核心目录发布的类型、Minecraft 版本和产物文件名创建 SeaShard 托管实例；Host 分配目录、固定核心落盘名，并使用服务器全局下载并发数。",
      confirmationLevel: 1,
      inputSchema: createInstanceInputSchema,
      outputDescription:
        "下载、摘要校验和实例登记完成后，返回 before:null、最新实例安全投影和不含路径、URL、摘要的下载回执。",
      examples: [
        {
          serverType: "paper",
          gameVersion: "1.21.1",
          artifactFileName: "paper-1.21.1.jar",
        },
      ],
    },
    (input, execution) => createManagedServerInstance(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "rename-instance",
      title: "修改服务器实例名称",
      description:
        "修改一个已登记实例的 SeaShard 显示名称；不会重命名实例目录、核心文件或世界目录，服务器运行期间也可执行。",
      confirmationLevel: 1,
      inputSchema: renameInstanceInputSchema,
      outputDescription:
        "返回修改前后的实例安全投影和 changed；规范化后的名称与当前名称相同时 changed 为 false。",
      examples: [{ instanceId: "server-1", name: "生存服务器" }],
    },
    (input, execution) => renameServerInstance(options, input, execution),
  );

  context.agentTool(
    {
      namespace: "server",
      name: "delete-instance",
      title: "删除托管服务器实例",
      description:
        "永久删除一个已登记的 SeaShard 托管实例、实例内服务器文件和登记记录；外部实例、运行中实例或仍在下载的实例会被拒绝。",
      confirmationLevel: 2,
      inputSchema: deleteInstanceInputSchema,
      outputDescription:
        "返回删除前的实例安全投影、after:null、registrationRemoved:true 和 localFilesDeleted:true。",
      examples: [{ instanceId: "server-1" }],
    },
    (input, execution) => deleteManagedServerInstance(options, input, execution),
  );
}

async function createManagedServerInstance(
  options: ServerInstanceAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseCreateInstanceInput(value);
  const connections = await waitForInvocation(
    options.getDefaultDownloadConnections(),
    execution.signal,
  );
  // 设置读取是创建前最后一个纯读取阶段；取消后不能再分配目录或启动下载。
  execution.signal?.throwIfAborted();

  const created = await waitForInvocation(
    options.createManaged({
      ...input,
      destinationFileName: "server.jar",
      connections,
    }),
    execution.signal,
  );
  // 下载开始后，Invocation 取消只停止等待；Instance Manager 继续完成校验、登记或失败清理。
  await waitForInvocation(options.waitForManagedTask(created.task.id), execution.signal);
  execution.signal?.throwIfAborted();

  const [task, instances] = await Promise.all([
    options.snapshotManagedTask(created.task.id),
    options.listInstances(),
  ]);
  execution.signal?.throwIfAborted();
  if (!task || task.state !== "completed") {
    throw new Error(`服务器核心下载未完成：${task?.state ?? "missing"}`);
  }
  const instance = instances.find(({ id }) => id === created.instanceId);
  if (!instance) {
    throw new Error(`服务器核心下载完成，但实例 ${created.instanceId} 尚未登记`);
  }
  return {
    before: null,
    after: projectServerForAgent(instance),
    download: projectCoreDownloadForAgent(task),
  };
}

async function renameServerInstance(
  options: ServerInstanceAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseRenameInstanceInput(value);
  const before = await findInstance(options, input.instanceId, execution.signal);
  // 实例存在性检查完成后保留取消落点，避免已取消调用继续写入私有清单。
  execution.signal?.throwIfAborted();
  const after = await waitForInvocation(
    options.rename(input.instanceId, input.name),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return {
    before: projectServerForAgent(before),
    after: projectServerForAgent(after),
    changed: before.name !== after.name,
  };
}

async function deleteManagedServerInstance(
  options: ServerInstanceAgentToolOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const instanceId = parseInstanceTargetInput(value, "server_delete-instance");
  const before = await findInstance(options, instanceId, execution.signal);
  if (before.storageMode !== "managed") {
    throw new Error(`服务器实例 ${instanceId} 不是 SeaShard 托管实例，不能删除本地目录`);
  }
  // 删除前最后一次接受取消；进入领域事务后由 Runtime Gate 和删除回滚机制负责结算。
  execution.signal?.throwIfAborted();
  await waitForInvocation(options.delete(instanceId), execution.signal);
  execution.signal?.throwIfAborted();
  return {
    before: projectServerForAgent(before),
    after: null,
    registrationRemoved: true,
    localFilesDeleted: true,
  };
}

async function findInstance(
  options: Pick<ServerInstanceAgentToolOptions, "listInstances">,
  instanceId: string,
  signal?: AbortSignal,
): Promise<ServerInstanceSnapshot> {
  const instances = await waitForInvocation(options.listInstances(), signal);
  const instance = instances.find(({ id }) => id === instanceId);
  if (!instance) throw new Error(`服务器实例不存在：${instanceId}`);
  return instance;
}

function projectCoreDownloadForAgent(task: ServerCoreDownloadTaskSnapshot): JsonObject {
  return {
    taskId: task.id,
    state: task.state,
    downloadedBytes: task.downloadedBytes,
    totalBytes: task.totalBytes,
    progress: task.progress,
    source: task.artifact.source,
    serverType: task.artifact.serverType,
    gameVersion: task.artifact.gameVersion,
    artifactFileName: task.artifact.fileName,
  };
}

function parseCreateInstanceInput(value: JsonValue): CreateInstanceInput {
  const input = expectObject(value, "server_create-instance");
  return {
    serverType: expectCatalogIdentity(input.serverType, "serverType"),
    gameVersion: expectCatalogIdentity(input.gameVersion, "gameVersion"),
    artifactFileName: expectArtifactFileName(input.artifactFileName),
  };
}

function parseRenameInstanceInput(value: JsonValue): RenameInstanceInput {
  const input = expectObject(value, "server_rename-instance");
  return {
    instanceId: expectInstanceId(input.instanceId),
    name: expectInstanceName(input.name),
  };
}

function parseInstanceTargetInput(value: JsonValue, label: string): string {
  return expectInstanceId(expectObject(value, label).instanceId);
}

function expectObject(value: JsonValue, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} input 必须是对象`);
  }
  return value;
}

function expectCatalogIdentity(value: JsonValue | undefined, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumIdentityLength ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new TypeError(`${field} 必须是核心目录返回的普通标识符`);
  }
  return value;
}

function expectArtifactFileName(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > maximumArtifactFileNameLength ||
    value.includes("/") ||
    value.includes("\\") ||
    !value.toLowerCase().endsWith(".jar")
  ) {
    throw new TypeError("artifactFileName 必须是核心目录返回的 JAR 文件名");
  }
  return value;
}

function expectInstanceId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !instanceIdPattern.test(value)) {
    throw new TypeError("服务器实例 ID 不合法");
  }
  return value;
}

function expectInstanceName(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new TypeError("服务器实例名称必须是字符串");
  const name = value.trim();
  if (!name || name.length > maximumInstanceNameLength || /[\u0000-\u001F\u007F]/u.test(name)) {
    throw new TypeError(`服务器实例名称必须为 1～${maximumInstanceNameLength} 个可见字符`);
  }
  return name;
}

/** Invocation 取消只停止 Agent 等待；已经启动的下载或领域事务继续安全结算。 */
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
