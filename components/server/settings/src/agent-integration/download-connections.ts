import { serverDownloadConnectionLimits } from "@seashard/contracts";
import type {
  AgentToolExecutionContext,
  JsonObject,
  JsonValue,
  PluginContext,
} from "@seashard/plugin-sdk";
import {
  expectInteger,
  expectObject,
  projectMutation,
  type ServerSettingsAgentRegistrationOptions,
} from "./shared";

const downloadConnectionsInputProperties: Readonly<Record<string, true>> = {
  connections: true,
};
const downloadConnectionsInputSchema: JsonObject = {
  type: "object",
  properties: {
    connections: {
      type: "integer",
      minimum: serverDownloadConnectionLimits.minimum,
      maximum: serverDownloadConnectionLimits.maximum,
      description: "后续服务器资源下载默认使用的并发连接数。",
    },
  },
  required: ["connections"],
  additionalProperties: false,
};

interface DownloadConnectionsInput {
  readonly connections: number;
}

type DownloadConnectionsAgentOptions = Pick<
  ServerSettingsAgentRegistrationOptions,
  "setDefaultDownloadConnections"
>;

/** 下载并发属于独立低风险设置域，保持自己的 Schema、确认等级和执行边界。 */
export function registerServerDownloadConnectionsAgentTool(
  context: Pick<PluginContext, "agentTool">,
  options: DownloadConnectionsAgentOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "set-default-download-connections",
      title: "修改服务器默认下载并发数",
      description: "修改后续服务器资源下载使用的全局默认并发连接数；不会改变已经开始的下载任务。",
      confirmationLevel: 1,
      inputSchema: downloadConnectionsInputSchema,
      outputDescription:
        "返回修改前后的服务器设置安全投影和 changed；不包含资源下载目录等宿主绝对路径。",
      examples: [{ connections: 8 }],
    },
    (input, execution) => setDefaultDownloadConnections(options, input, execution),
  );
}

async function setDefaultDownloadConnections(
  options: DownloadConnectionsAgentOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  const input = parseDownloadConnectionsInput(value);
  // 这是最后一个取消窗口；进入设置写队列后必须返回真实结算结果。
  execution.signal?.throwIfAborted();
  const receipt = await options.setDefaultDownloadConnections(input.connections);
  return projectMutation(receipt);
}

function parseDownloadConnectionsInput(value: JsonValue): DownloadConnectionsInput {
  const input = expectObject(
    value,
    "server_set-default-download-connections",
    downloadConnectionsInputProperties,
  );
  return {
    connections: expectInteger(
      input.connections,
      "connections",
      serverDownloadConnectionLimits.minimum,
      serverDownloadConnectionLimits.maximum,
    ),
  };
}
