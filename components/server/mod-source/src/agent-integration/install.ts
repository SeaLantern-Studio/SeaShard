import type { ServerInstalledModSnapshot, ServerModSource } from "@seashard/contracts";
import type {
  AgentToolExecutionContext,
  JsonObject,
  JsonValue,
  PluginContext,
} from "@seashard/plugin-sdk";
import { projectInstalledModForAgent } from "@seashard/server-instance-manager";
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
  type ServerModCatalogAgentRegistrationOptions,
} from "./shared";

const maximumFileNameLength = 300;
const maximumReceiptModCount = 20;
const installInputProperties: Readonly<Record<string, true>> = {
  source: true,
  projectId: true,
  versionId: true,
  version: true,
  instanceId: true,
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
  description: "Mod 目录返回的来源项目 ID。",
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
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$",
  description: "目标服务器实例 ID；可先读取 server://instances 获取。",
};

const installModInputSchema: JsonObject = {
  type: "object",
  properties: {
    source: sourceProperty,
    projectId: projectIdProperty,
    versionId: versionIdProperty,
    version: readableVersionProperty,
    instanceId: instanceIdProperty,
  },
  required: ["source", "projectId", "instanceId"],
  oneOf: [{ required: ["versionId"] }, { required: ["version"] }],
  additionalProperties: false,
};

interface InstallModInput {
  readonly source: ServerModSource;
  readonly projectId: string;
  readonly instanceId: string;
  readonly versionId?: string;
  readonly version?: string;
}

/** 安装工具独立于目录资源，后续扩展数据包、世界和整合包时无需继续堆叠同一模块。 */
export function registerServerModInstallAgentTool(
  context: Pick<PluginContext, "agentTool">,
  options: ServerModCatalogAgentRegistrationOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "install-mod",
      title: "安装服务器 Mod",
      description:
        "把 Mod 目录详情中的指定版本安装到已登记服务器实例；可提交稳定 versionId，或提交无歧义的可读 version。Host 会重新解析来源产物、检查 Minecraft 版本和加载器、执行公共下载任务并记录来源。",
      confirmationLevel: 1,
      inputSchema: installModInputSchema,
      outputDescription:
        "返回同来源项目在安装前后的有界 Mod 状态，以及不含 URL、摘要或宿主路径的下载结果。",
      examples: [
        {
          source: "modrinth",
          projectId: "gvQqBUqZ",
          version: "0.14.0",
          instanceId: "server-1",
        },
        {
          source: "modrinth",
          projectId: "gvQqBUqZ",
          versionId: "AANobbMI",
          instanceId: "server-1",
        },
      ],
    },
    (input, execution) => installServerMod(options, input, execution),
  );
}

async function installServerMod(
  options: ServerModCatalogAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseInstallModInput(value);
  const versionId = await resolveInstallVersionId(options, input, execution.signal);
  const beforeMods = await waitForInvocation(
    options.listInstalledMods(input.instanceId),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  const before = projectProjectModReceipt(beforeMods, input.source, input.projectId);

  // 下载和安装是完整领域事务；Invocation 取消只停止等待，不把信号传播到下载任务。
  const download = await waitForInvocation(
    options.installToInstance({
      source: input.source,
      resourceType: "mod",
      projectId: input.projectId,
      versionId,
      instanceId: input.instanceId,
    }),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  const afterMods = await waitForInvocation(
    options.listInstalledMods(input.instanceId),
    execution.signal,
  );
  execution.signal?.throwIfAborted();
  return {
    before,
    after: projectProjectModReceipt(afterMods, input.source, input.projectId),
    download: {
      source: download.source,
      projectId: download.projectId,
      versionId: download.versionId,
      fileName: truncateText(download.fileName, maximumFileNameLength),
      instanceId: download.instanceId ?? input.instanceId,
      downloadedBytes: download.downloadedBytes,
    },
  };
}

function projectProjectModReceipt(
  mods: readonly ServerInstalledModSnapshot[],
  source: ServerModSource,
  projectId: string,
): JsonObject {
  const matching = mods.filter(
    (mod) => mod.resourceSource?.source === source && mod.resourceSource.id === projectId,
  );
  return {
    items: matching.slice(0, maximumReceiptModCount).map((mod) => projectInstalledModForAgent(mod)),
    totalItems: matching.length,
    omittedItems: Math.max(0, matching.length - maximumReceiptModCount),
  };
}

function parseInstallModInput(value: JsonValue): InstallModInput {
  const input = expectObject(value, "server_install-mod", installInputProperties);
  const versionId =
    input.versionId === undefined ? undefined : expectIdentity(input.versionId, "versionId");
  const version = readOptionalText(input.version, "version", maximumVersionLength)?.trim();
  if (Boolean(versionId) === Boolean(version)) {
    throw new TypeError("server_install-mod 必须且只能提交 versionId 或 version 其中一个");
  }
  return {
    source: expectConcreteSource(input.source),
    projectId: expectIdentity(input.projectId, "projectId"),
    instanceId: expectInstanceId(input.instanceId),
    ...(versionId ? { versionId } : { version: version! }),
  };
}
