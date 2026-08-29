import type {
  ServerModDownloadResult,
  ServerModSource,
  ServerWorldDatapackSnapshot,
} from "@seashard/contracts";
import type {
  AgentToolExecutionContext,
  JsonObject,
  JsonValue,
  PluginContext,
} from "@seashard/plugin-sdk";
import { projectInstalledDatapackForAgent } from "@seashard/server-instance-manager";
import {
  concreteSources,
  expectConcreteSource,
  expectIdentity,
  expectInstanceId,
  expectObject,
  maximumIdentityLength,
  maximumVersionLength,
  readOptionalText,
  resolveInstallVersionId,
  truncateText,
  waitForInvocation,
  type ServerDatapackCatalogAgentRegistrationOptions,
} from "./shared";

const maximumFileNameLength = 300;
const maximumWorldIdLength = 512;
const maximumReceiptDatapackCount = 20;
const installInputProperties: Readonly<Record<string, true>> = {
  source: true,
  projectId: true,
  versionId: true,
  version: true,
  instanceId: true,
  worldId: true,
};

const sourceProperty: JsonObject = {
  type: "string",
  enum: [...concreteSources],
  description: "项目所属来源；详情资源返回的 source 必须原样传入，不能使用 all。",
};
const projectIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumIdentityLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
  description: "数据包目录返回的来源项目 ID。",
};
const versionIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumIdentityLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
  description: "项目详情资源返回的稳定来源版本 ID；与 version 二选一。",
};
const readableVersionProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumVersionLength,
  description:
    "项目详情资源返回的可读版本号或版本名称；与 versionId 二选一。存在重名时必须改用稳定 versionId。",
};
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

const installDatapackInputSchema: JsonObject = {
  type: "object",
  properties: {
    source: sourceProperty,
    projectId: projectIdProperty,
    versionId: versionIdProperty,
    version: readableVersionProperty,
    instanceId: instanceIdProperty,
    worldId: worldIdProperty,
  },
  required: ["source", "projectId", "instanceId", "worldId"],
  oneOf: [{ required: ["versionId"] }, { required: ["version"] }],
  additionalProperties: false,
};

interface InstallDatapackInput {
  readonly source: ServerModSource;
  readonly projectId: string;
  readonly instanceId: string;
  readonly worldId: string;
  readonly versionId?: string;
  readonly version?: string;
}

/** 数据包安装把来源身份绑定到一个已登记实例的明确逻辑世界，不接受路径或下载地址。 */
export function registerServerDatapackInstallAgentTool(
  context: Pick<PluginContext, "agentTool">,
  options: ServerDatapackCatalogAgentRegistrationOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "install-datapack",
      title: "安装服务器数据包",
      description:
        "把数据包目录详情中的指定版本安装到已登记服务器实例的明确世界；可提交稳定 versionId，或提交无歧义的可读 version。Host 会重新解析来源产物、检查 Minecraft 版本、执行公共下载任务并记录来源。",
      confirmationLevel: 1,
      inputSchema: installDatapackInputSchema,
      outputDescription:
        "返回目标世界中同来源项目在安装前后的有界数据包状态，以及不含 URL、摘要或宿主路径的下载结果。",
      examples: [
        {
          source: "modrinth",
          projectId: "8GmQYwTg",
          version: "1.4.1",
          instanceId: "server-1",
          worldId: "world",
        },
        {
          source: "curseforge",
          projectId: "123456",
          versionId: "789012",
          instanceId: "server-1",
          worldId: "world",
        },
      ],
    },
    (input, execution) => installServerDatapack(options, input, execution),
  );
}

async function installServerDatapack(
  options: ServerDatapackCatalogAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseInstallDatapackInput(value);
  const versionId = await resolveInstallVersionId(options, input, execution.signal);
  const beforeDatapacks = await waitForInvocation(
    options.listInstalledDatapacks(input.instanceId, input.worldId),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  const before = projectProjectDatapackReceipt(beforeDatapacks, input.source, input.projectId);

  // 下载和安装是完整领域事务；Invocation 取消只停止等待，不把信号传播到下载任务。
  const download = await waitForInvocation(
    options.installToInstance({
      source: input.source,
      resourceType: "datapack",
      projectId: input.projectId,
      versionId,
      instanceId: input.instanceId,
      worldId: input.worldId,
    }),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  const afterDatapacks = await waitForInvocation(
    options.listInstalledDatapacks(input.instanceId, input.worldId),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return {
    before,
    after: projectProjectDatapackReceipt(afterDatapacks, input.source, input.projectId),
    download: projectDatapackDownload(download, input),
  };
}

function projectProjectDatapackReceipt(
  datapacks: readonly ServerWorldDatapackSnapshot[],
  source: ServerModSource,
  projectId: string,
): JsonObject {
  const matching = datapacks.filter(
    (datapack) =>
      datapack.resourceSource?.source === source && datapack.resourceSource.id === projectId,
  );
  return {
    items: matching
      .slice(0, maximumReceiptDatapackCount)
      .map((datapack) => projectInstalledDatapackForAgent(datapack)),
    totalItems: matching.length,
    omittedItems: Math.max(0, matching.length - maximumReceiptDatapackCount),
  };
}

function projectDatapackDownload(
  download: ServerModDownloadResult,
  input: InstallDatapackInput,
): JsonObject {
  return {
    source: download.source,
    projectId: download.projectId,
    versionId: download.versionId,
    fileName: truncateText(download.fileName, maximumFileNameLength),
    instanceId: download.instanceId ?? input.instanceId,
    worldId: input.worldId,
    downloadedBytes: download.downloadedBytes,
  };
}

function parseInstallDatapackInput(value: JsonValue): InstallDatapackInput {
  const input = expectObject(value, "server_install-datapack", installInputProperties);
  const versionId =
    input.versionId === undefined ? undefined : expectIdentity(input.versionId, "versionId");
  const version = readOptionalText(input.version, "version", maximumVersionLength)?.trim();
  if (Boolean(versionId) === Boolean(version)) {
    throw new TypeError("server_install-datapack 必须且只能提交 versionId 或 version 其中一个");
  }
  return {
    source: expectConcreteSource(input.source, "数据包"),
    projectId: expectIdentity(input.projectId, "projectId"),
    instanceId: expectInstanceId(input.instanceId),
    worldId: expectWorldId(input.worldId),
    ...(versionId ? { versionId } : { version: version! }),
  };
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
