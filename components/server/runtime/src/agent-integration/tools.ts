import {
  type AgentToolExecutionContext,
  type JsonObject,
  type JsonValue,
  type PluginContext,
} from "@seashard/plugin-sdk";
import {
  appendOptionalLine,
  expectInstanceId,
  expectObject,
  expectOutputNumber,
  expectOutputString,
  findInstance,
  formatInstanceIdentity,
  instanceIdProperty,
  jsonOutputProperty,
  readOptionalBoolean,
  truncateConsoleText,
  type ServerRuntimeAgentRegistrationOptions,
} from "./shared";

const maximumCommandLength = 32_768;
const defaultWaitTimeoutSeconds = 300;
const maximumWaitTimeoutSeconds = 900;

interface RuntimeToolInput {
  readonly instanceId: string;
  readonly json: boolean;
}

interface RuntimeWaitToolInput extends RuntimeToolInput {
  readonly timeoutSeconds: number;
}

interface CommandToolInput extends RuntimeToolInput {
  readonly command: string;
}

const runtimeToolInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    json: jsonOutputProperty,
  },
  required: ["instanceId"],
  additionalProperties: false,
};

const runtimeWaitToolInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: maximumWaitTimeoutSeconds,
      default: defaultWaitTimeoutSeconds,
      description: "最长等待秒数；超时后工具会结束并提示读取服务器日志。",
    },
    json: jsonOutputProperty,
  },
  required: ["instanceId"],
  additionalProperties: false,
};

const commandToolInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
    command: {
      type: "string",
      minLength: 1,
      maxLength: maximumCommandLength,
      description: "发送给服务器进程的单行控制台命令；不得包含空字符或换行符。",
    },
    json: jsonOutputProperty,
  },
  required: ["instanceId", "command"],
  additionalProperties: false,
};

/** 注册进程控制工具；领域方法继续由 Runtime Manager 注入，工具层只负责安全边界与投影。 */
export function registerServerRuntimeAgentTools(
  context: Pick<PluginContext, "agentTool">,
  options: ServerRuntimeAgentRegistrationOptions,
): void {
  context.agentTool(
    {
      namespace: "server",
      name: "start",
      title: "启动服务器",
      description: "启动一个已登记且当前未运行的服务器实例。",
      confirmationLevel: 1,
      inputSchema: runtimeToolInputSchema,
      outputDescription: "返回服务器名称、运行状态、启动时间和启动日志序号。",
      examples: [{ instanceId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => startServer(options, input, execution),
  );
  context.agentTool(
    {
      namespace: "server",
      name: "stop",
      title: "停止服务器",
      description: "向正在运行的服务器发送该核心定义的安全停止命令。",
      confirmationLevel: 1,
      inputSchema: runtimeToolInputSchema,
      outputDescription: "返回 stopping 状态和安全停止命令对应的日志序号。",
      examples: [{ instanceId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => stopServer(options, input, execution),
  );
  context.agentTool(
    {
      namespace: "server",
      name: "wait-ready",
      title: "等待服务器启动完成",
      description:
        "在 server_start 之后等待当前服务器进程输出该核心的启动完成标志；不会把历史运行日志误判为本次就绪。",
      confirmationLevel: 0,
      inputSchema: runtimeWaitToolInputSchema,
      outputDescription: "返回服务器就绪状态、命中的核心日志、日志序号和就绪时间。",
      examples: [{ instanceId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => waitForServerReady(options, input, execution),
  );
  context.agentTool(
    {
      namespace: "server",
      name: "wait-stopped",
      title: "等待服务器完全停止",
      description: "在 server_stop 之后等待服务器进程完全退出，并等待实例运行生命周期释放完成。",
      confirmationLevel: 0,
      inputSchema: runtimeWaitToolInputSchema,
      outputDescription: "返回最终 stopped 或 failed 状态、停止时间、退出码和错误信息。",
      examples: [{ instanceId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => waitForServerStopped(options, input, execution),
  );
  context.agentTool(
    {
      namespace: "server",
      name: "send-command",
      title: "发送服务器命令",
      description: "向正在运行且可接收命令的服务器进程发送一条控制台命令。",
      confirmationLevel: 1,
      inputSchema: commandToolInputSchema,
      outputDescription: "返回命令接收状态和本次 input 日志序号。",
      examples: [
        {
          instanceId: "550e8400-e29b-41d4-a716-446655440000",
          command: "list",
        },
      ],
    },
    (input, execution) => sendServerCommand(options, input, execution),
  );
}

async function startServer(
  options: ServerRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseRuntimeToolInput(value, "server_start");
  const instance = await findInstance(options, input.instanceId);
  execution.signal?.throwIfAborted();
  const receipt = await options.start(input.instanceId);
  if (receipt.snapshot.state !== "running" || !receipt.snapshot.startedAt) {
    throw new Error(`server instance ${input.instanceId} returned an incomplete start receipt`);
  }
  const output: JsonObject = {
    instanceId: input.instanceId,
    name: instance.name,
    state: "running",
    startedAt: receipt.snapshot.startedAt,
    startedLogSequence: receipt.startedLogSequence,
  };
  return input.json ? output : formatStartText(output);
}

async function stopServer(
  options: ServerRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseRuntimeToolInput(value, "server_stop");
  const instance = await findInstance(options, input.instanceId);
  if ((await options.getRuntime(input.instanceId)).state !== "running") {
    throw new Error(`server instance ${input.instanceId} is not running`);
  }
  execution.signal?.throwIfAborted();
  const receipt = await options.stop(input.instanceId);
  if (receipt.snapshot.state !== "stopping") {
    throw new Error(`server instance ${input.instanceId} returned an incomplete stop receipt`);
  }
  const output: JsonObject = {
    instanceId: input.instanceId,
    name: instance.name,
    state: "stopping",
    stopCommandLogSequence: receipt.stopCommandLogSequence,
  };
  return input.json ? output : formatStopText(output);
}

async function waitForServerReady(
  options: ServerRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseRuntimeWaitToolInput(value, "server_wait-ready");
  const instance = await findInstance(options, input.instanceId);
  execution.signal?.throwIfAborted();
  const receipt = await options.waitUntilReady(input.instanceId, {
    timeoutMs: input.timeoutSeconds * 1_000,
    ...(execution.signal ? { signal: execution.signal } : {}),
  });
  execution.signal?.throwIfAborted();
  const output: JsonObject = {
    instanceId: input.instanceId,
    name: instance.name,
    ready: true,
    state: receipt.snapshot.state,
    readyAt: receipt.readyAt,
    readyLogSequence: receipt.readyLogSequence,
    readyMarker: truncateConsoleText(receipt.readyMarker),
  };
  return input.json ? output : formatReadyText(output);
}

async function waitForServerStopped(
  options: ServerRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseRuntimeWaitToolInput(value, "server_wait-stopped");
  const instance = await findInstance(options, input.instanceId);
  execution.signal?.throwIfAborted();
  const receipt = await options.waitUntilStopped(input.instanceId, {
    timeoutMs: input.timeoutSeconds * 1_000,
    ...(execution.signal ? { signal: execution.signal } : {}),
  });
  execution.signal?.throwIfAborted();
  const output: JsonObject = {
    instanceId: input.instanceId,
    name: instance.name,
    state: receipt.snapshot.state,
  };
  if (receipt.snapshot.startedAt) output.startedAt = receipt.snapshot.startedAt;
  if (receipt.snapshot.stoppedAt) output.stoppedAt = receipt.snapshot.stoppedAt;
  if (receipt.snapshot.exitCode !== undefined) output.exitCode = receipt.snapshot.exitCode;
  if (receipt.snapshot.error) output.error = receipt.snapshot.error;
  return input.json ? output : formatStoppedText(output);
}

async function sendServerCommand(
  options: ServerRuntimeAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const input = parseCommandToolInput(value);
  const instance = await findInstance(options, input.instanceId);
  execution.signal?.throwIfAborted();
  const receipt = await options.sendCommand(input.instanceId, input.command);
  const output: JsonObject = {
    instanceId: input.instanceId,
    name: instance.name,
    accepted: receipt.accepted,
    commandLogSequence: receipt.commandLogSequence,
  };
  return input.json ? output : formatCommandText(output);
}

function formatStartText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`State: ${expectOutputString(output.state, "state")}`);
  lines.push(`Started at: ${expectOutputString(output.startedAt, "startedAt")}`);
  lines.push(
    `Startup log sequence: ${expectOutputNumber(output.startedLogSequence, "startedLogSequence")}`,
  );
  return lines.join("\n");
}

function formatStopText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`State: ${expectOutputString(output.state, "state")}`);
  lines.push(
    `Stop command log sequence: ${expectOutputNumber(
      output.stopCommandLogSequence,
      "stopCommandLogSequence",
    )}`,
  );
  return lines.join("\n");
}

function formatReadyText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`Ready: ${output.ready === true ? "yes" : "no"}`);
  lines.push(`State: ${expectOutputString(output.state, "state")}`);
  lines.push(`Ready at: ${expectOutputString(output.readyAt, "readyAt")}`);
  lines.push(
    `Ready log sequence: ${expectOutputNumber(output.readyLogSequence, "readyLogSequence")}`,
  );
  lines.push(`Readiness marker: ${expectOutputString(output.readyMarker, "readyMarker")}`);
  return lines.join("\n");
}

function formatStoppedText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`State: ${expectOutputString(output.state, "state")}`);
  appendOptionalLine(lines, "Started at", output.startedAt);
  appendOptionalLine(lines, "Stopped at", output.stoppedAt);
  if (typeof output.exitCode === "number") lines.push(`Exit code: ${output.exitCode}`);
  appendOptionalLine(lines, "Error", output.error);
  return lines.join("\n");
}

function formatCommandText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`Command accepted: ${output.accepted === true ? "yes" : "no"}`);
  lines.push(
    `Command log sequence: ${expectOutputNumber(output.commandLogSequence, "commandLogSequence")}`,
  );
  return lines.join("\n");
}

function parseRuntimeToolInput(value: JsonValue, label: string): RuntimeToolInput {
  const input = expectObject(value, label, ["instanceId", "json"]);
  return {
    instanceId: expectInstanceId(input.instanceId),
    json: readOptionalBoolean(input.json, `${label} json`) ?? false,
  };
}

function parseRuntimeWaitToolInput(value: JsonValue, label: string): RuntimeWaitToolInput {
  const input = expectObject(value, label, ["instanceId", "timeoutSeconds", "json"]);
  return {
    instanceId: expectInstanceId(input.instanceId),
    timeoutSeconds:
      readOptionalWaitTimeoutSeconds(input.timeoutSeconds, label) ?? defaultWaitTimeoutSeconds,
    json: readOptionalBoolean(input.json, `${label} json`) ?? false,
  };
}

function parseCommandToolInput(value: JsonValue): CommandToolInput {
  const input = expectObject(value, "server_send-command", ["instanceId", "command", "json"]);
  return {
    instanceId: expectInstanceId(input.instanceId),
    command: expectCommand(input.command),
    json: readOptionalBoolean(input.json, "server_send-command json") ?? false,
  };
}

function expectCommand(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new TypeError("server command must be a string");
  const command = value.trim();
  if (
    !command ||
    command.length > maximumCommandLength ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes("\n")
  ) {
    throw new TypeError("server command must be one non-empty line");
  }
  return command;
}

function readOptionalWaitTimeoutSeconds(
  value: JsonValue | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumWaitTimeoutSeconds
  ) {
    throw new TypeError(
      `${label} timeoutSeconds 必须是 1～${maximumWaitTimeoutSeconds} 的安全整数`,
    );
  }
  return value;
}
