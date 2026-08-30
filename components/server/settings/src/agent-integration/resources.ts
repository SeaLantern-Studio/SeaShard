import {
  defineAgentResource,
  type AgentActivityPresentationField,
  type AgentResource,
  type AgentResourceExecutionContext,
  type AgentResourceReadRequest,
  type AgentResourceReadResult,
  type JsonObject,
} from "@seashard/plugin-sdk";
import {
  expectObject,
  projectServerSettings,
  type ServerSettingsAgentRegistrationOptions,
} from "./shared";

const resourceInputProperties: Readonly<Record<string, true>> = {};
const settingsResourceInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** 设置资源只发布服务器行为默认值，宿主文件选择结果始终留在 Host。 */
export function createServerSettingsResource(
  options: Pick<ServerSettingsAgentRegistrationOptions, "get">,
): AgentResource {
  return defineAgentResource({
    description:
      "读取 SeaShard 的服务器全局下载并发数和首次启动默认值；启动时默认值会固化到实例，结果不包含资源下载目录等宿主绝对路径。",
    inputSchema: settingsResourceInputSchema,
    outputDescription:
      "返回默认下载并发数，以及尚未固化实例首次启动时采用的内存、端口、EULA 和 JVM 参数设置。",
    examples: [{}],
    help: "修改下载并发数使用 server_set-default-download-connections；修改首次启动默认值使用 server_update-startup-defaults。",
    presentation: { title: "读取服务器默认设置", icon: "wrench" },
    implementation: {
      read: (request, execution) => readServerSettings(options, request, execution),
      presentResult: presentServerSettingsResult,
    },
  });
}

async function readServerSettings(
  options: Pick<ServerSettingsAgentRegistrationOptions, "get">,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  expectObject(request.input, "服务器设置资源", resourceInputProperties);
  execution.signal?.throwIfAborted();
  const snapshot = await options.get();
  execution.signal?.throwIfAborted();
  return {
    mimeType: "application/json",
    content: projectServerSettings(snapshot),
  };
}

function presentServerSettingsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const content = expectObject(result.content, "服务器设置资源结果");
  const startupDefaults = expectObject(content.startupDefaults, "服务器启动默认值结果");
  return [
    {
      label: "默认内存",
      value: `${expectOutputNumber(startupDefaults.minimumMemoryMiB)}～${expectOutputNumber(startupDefaults.maximumMemoryMiB)}`,
      unit: "MiB",
    },
    { label: "默认端口", value: String(expectOutputNumber(startupDefaults.serverPort)) },
  ];
}

function expectOutputNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("服务器设置资源结果字段必须是有限数字");
  }
  return value;
}
