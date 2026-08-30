import { serverJvmArgumentsMaximumLength, serverPortLimits } from "@seashard/contracts";
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
  type ServerSettingsAgentStartupDefaultsPatch,
} from "./shared";

const maximumMemoryMiB = Number.MAX_SAFE_INTEGER;
const startupDefaultsInputProperties: Readonly<Record<string, true>> = {
  minimumMemoryMiB: true,
  maximumMemoryMiB: true,
  serverPort: true,
  autoAcceptEula: true,
  jvmArguments: true,
};
const startupDefaultsInputSchema: JsonObject = {
  type: "object",
  properties: {
    minimumMemoryMiB: {
      type: "integer",
      minimum: 1,
      maximum: maximumMemoryMiB,
      description: "尚未固化启动设置的服务器首次启动时采用的默认最小堆内存，单位 MiB。",
    },
    maximumMemoryMiB: {
      type: "integer",
      minimum: 1,
      maximum: maximumMemoryMiB,
      description: "尚未固化启动设置的服务器首次启动时采用的默认最大堆内存，单位 MiB。",
    },
    serverPort: {
      type: "integer",
      minimum: serverPortLimits.minimum,
      maximum: serverPortLimits.maximum,
      description: "尚未固化启动设置的服务器首次启动时采用的默认端口。",
    },
    autoAcceptEula: {
      type: "boolean",
      description: "首次启动固化设置时是否自动接受 Minecraft EULA。",
    },
    jvmArguments: {
      type: "string",
      maxLength: serverJvmArgumentsMaximumLength,
      description: "首次启动固化的默认附加 JVM 参数；空字符串表示不追加参数。",
    },
  },
  minProperties: 1,
  additionalProperties: false,
};

type StartupDefaultsAgentOptions = Pick<
  ServerSettingsAgentRegistrationOptions,
  "updateStartupDefaults"
>;

/** 启动默认值必须作为一个设置域注册，跨字段约束继续由 Host 写队列原子校验。 */
export function registerServerStartupDefaultsAgentTool(
  context: Pick<PluginContext, "agentTool">,
  options: StartupDefaultsAgentOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "update-startup-defaults",
      title: "修改服务器首次启动默认值",
      description:
        "部分更新尚未固化启动设置的服务器将在首次启动时复制的默认内存、端口、EULA 和 JVM 参数；已经固化或由用户保存实例设置的服务器不受影响。",
      confirmationLevel: 2,
      inputSchema: startupDefaultsInputSchema,
      outputDescription:
        "返回修改前后的服务器设置安全投影和 changed；Host 会在同一写队列中合并并校验完整默认值。",
      examples: [
        { minimumMemoryMiB: 1_024, maximumMemoryMiB: 4_096 },
        { serverPort: 25_570, autoAcceptEula: false },
      ],
    },
    (input, execution) => updateStartupDefaults(options, input, execution),
  );
}

async function updateStartupDefaults(
  options: StartupDefaultsAgentOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  const patch = parseStartupDefaultsPatch(value);
  // JVM 参数等默认值一旦开始持久化就继续结算，避免已提交修改被记录成取消。
  execution.signal?.throwIfAborted();
  const receipt = await options.updateStartupDefaults(patch);
  return projectMutation(receipt);
}

function parseStartupDefaultsPatch(value: JsonValue): ServerSettingsAgentStartupDefaultsPatch {
  const input = expectObject(
    value,
    "server_update-startup-defaults",
    startupDefaultsInputProperties,
  );
  if (Object.keys(input).length === 0) {
    throw new TypeError("server_update-startup-defaults 至少需要一个设置字段");
  }

  const minimumMemoryMiB = readOptionalInteger(
    input.minimumMemoryMiB,
    "minimumMemoryMiB",
    1,
    maximumMemoryMiB,
  );
  const maximumMemory = readOptionalInteger(
    input.maximumMemoryMiB,
    "maximumMemoryMiB",
    1,
    maximumMemoryMiB,
  );
  const serverPort = readOptionalInteger(
    input.serverPort,
    "serverPort",
    serverPortLimits.minimum,
    serverPortLimits.maximum,
  );
  const autoAcceptEula = readOptionalBoolean(input.autoAcceptEula, "autoAcceptEula");
  const jvmArguments = readOptionalJvmArguments(input.jvmArguments);
  return {
    ...(minimumMemoryMiB === undefined ? {} : { defaultMinimumMemoryMiB: minimumMemoryMiB }),
    ...(maximumMemory === undefined ? {} : { defaultMaximumMemoryMiB: maximumMemory }),
    ...(serverPort === undefined ? {} : { defaultServerPort: serverPort }),
    ...(autoAcceptEula === undefined ? {} : { autoAcceptEula }),
    ...(jvmArguments === undefined ? {} : { defaultJvmArguments: jvmArguments }),
  };
}

function readOptionalInteger(
  value: JsonValue | undefined,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : expectInteger(value, field, minimum, maximum);
}

function readOptionalBoolean(value: JsonValue | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${field} 必须是布尔值`);
  return value;
}

function readOptionalJvmArguments(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > serverJvmArgumentsMaximumLength ||
    value.includes("\0")
  ) {
    throw new TypeError(
      `jvmArguments 必须是不含 NUL 且不超过 ${serverJvmArgumentsMaximumLength} 个字符的字符串`,
    );
  }
  return value;
}
