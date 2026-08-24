import type {
  ServerConsoleLine,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
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
import type {
  ServerRuntimeCommandReceipt,
  ServerRuntimeStartReceipt,
  ServerRuntimeStopReceipt,
} from "./manager";

const defaultLogLimit = 100;
const maximumLogLimit = 200;
const maximumAgentLineLength = 4_096;
const maximumCommandLength = 32_768;

export interface ServerRuntimeAgentRegistrationOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  getRuntime(instanceId: string): ServerRuntimeSnapshot;
  getLogs(instanceId: string): readonly ServerConsoleLine[];
  start(instanceId: string): Promise<ServerRuntimeStartReceipt>;
  stop(instanceId: string): Promise<ServerRuntimeStopReceipt>;
  sendCommand(instanceId: string, command: string): Promise<ServerRuntimeCommandReceipt>;
}

interface RuntimeReadInput {
  readonly json: boolean;
}

interface LogsReadInput extends RuntimeReadInput {
  readonly afterSequence?: number;
  readonly limit: number;
}

interface RuntimeToolInput extends RuntimeReadInput {
  readonly instanceId: string;
}

interface CommandToolInput extends RuntimeToolInput {
  readonly command: string;
}

interface ProjectedConsoleLine {
  readonly sequence: number;
  readonly stream: ServerConsoleLine["stream"];
  readonly text: string;
  readonly timestamp: string;
  readonly truncated: boolean;
}

interface ConsolePage {
  readonly items: readonly ProjectedConsoleLine[];
  readonly firstSequence?: number;
  readonly lastSequence?: number;
  readonly earlierLineCount: number;
  readonly laterLineCount: number;
}

const jsonOutputProperty: JsonObject = {
  type: "boolean",
  default: false,
  description: "是否返回结构化 JSON；省略时返回便于直接阅读的英文文本。",
};

const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  description: "服务器实例 ID；可先读取 server://instances 获取。",
};

const runtimeResourceInputSchema: JsonObject = {
  type: "object",
  properties: {
    json: jsonOutputProperty,
  },
  additionalProperties: false,
};

const logsResourceInputSchema: JsonObject = {
  type: "object",
  properties: {
    afterSequence: {
      type: "integer",
      minimum: 0,
      description: "只返回该日志序号之后的日志；省略时返回最近的日志。",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: maximumLogLimit,
      default: defaultLogLimit,
      description: "本次最多返回的日志行数。",
    },
    json: jsonOutputProperty,
  },
  additionalProperties: false,
};

const runtimeToolInputSchema: JsonObject = {
  type: "object",
  properties: {
    instanceId: instanceIdProperty,
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

/**
 * Server Runtime 统一在独立文件中声明 Agent 资源和工具；组件入口只负责注入领域实现。
 * 资源读取与工具调用共享同一组投影函数，避免文本和 JSON 对状态含义产生分叉。
 */
export function registerServerRuntimeAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerRuntimeAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/runtime": createServerRuntimeResource(options),
    "server://instances/{instanceId}/logs": createServerRuntimeLogsResource(options),
  });

  context.agentTool(
    {
      namespace: "server",
      name: "start",
      title: "启动服务器",
      description: "启动一个已登记且当前未运行的服务器实例。",
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
      inputSchema: runtimeToolInputSchema,
      outputDescription: "返回 stopping 状态和安全停止命令对应的日志序号。",
      examples: [{ instanceId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => stopServer(options, input, execution),
  );
  context.agentTool(
    {
      namespace: "server",
      name: "send-command",
      title: "发送服务器命令",
      description: "向正在运行且可接收命令的服务器进程发送一条控制台命令。",
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

export function createServerRuntimeResource(
  options: ServerRuntimeAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定 SeaShard 服务器实例的当前进程状态、命令接收能力和本次运行时间信息；结果不包含 PID 或宿主路径。",
    inputSchema: runtimeResourceInputSchema,
    outputDescription: "默认返回英文文本；json=true 时返回结构化运行状态。",
    examples: [{ json: true }],
    help: "启动、停止和发送命令分别使用 server_start、server_stop 和 server_send-command。",
    presentation: { title: "读取服务器运行状态" },
    implementation: {
      read: (request, execution) => readServerRuntime(options, request, execution),
      presentRequest: (request) => presentRuntimeRequest(options, request),
    },
  });
}

export function createServerRuntimeLogsResource(
  options: ServerRuntimeAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定 SeaShard 服务器实例的控制台日志，包含 stdout、stderr、input 和 system；支持按递增序号继续读取。",
    inputSchema: logsResourceInputSchema,
    outputDescription:
      "默认返回带日志序号和省略计数的英文文本；json=true 时返回结构化日志与分页信息。",
    examples: [{ afterSequence: 50, limit: 100, json: true }],
    help: "afterSequence 使用上次结果的 lastSequence 或工具返回的日志序号。",
    presentation: { title: "读取服务器日志" },
    implementation: {
      read: (request, execution) => readServerLogs(options, request, execution),
      presentRequest: (request) => presentLogsRequest(options, request),
      presentResult: presentLogsResult,
    },
  });
}

async function readServerRuntime(
  options: ServerRuntimeAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const input = parseRuntimeReadInput(request.input, "服务器运行状态资源");
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const instance = await findInstance(options, instanceId);
  execution.signal?.throwIfAborted();
  const snapshot = options.getRuntime(instanceId);
  const projected = projectRuntime(instance, snapshot);
  return input.json
    ? { mimeType: "application/json", content: projected }
    : { mimeType: "text/plain; charset=utf-8", content: formatRuntimeText(projected) };
}

async function readServerLogs(
  options: ServerRuntimeAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const input = parseLogsReadInput(request.input);
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const instance = await findInstance(options, instanceId);
  execution.signal?.throwIfAborted();
  const page = paginateLogs(options.getLogs(instanceId), input);
  return input.json
    ? {
        mimeType: "application/json",
        content: projectLogsPage(instance, page),
      }
    : {
        mimeType: "text/plain; charset=utf-8",
        content: formatLogsText(instance, page),
      };
}

async function presentRuntimeRequest(
  options: ServerRuntimeAgentRegistrationOptions,
  request: AgentResourceReadRequest,
): Promise<readonly AgentActivityPresentationField[]> {
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const instance = await findInstance(options, instanceId);
  return [{ label: "服务器", value: instance.name }];
}

async function presentLogsRequest(
  options: ServerRuntimeAgentRegistrationOptions,
  request: AgentResourceReadRequest,
): Promise<readonly AgentActivityPresentationField[]> {
  const input = parseLogsReadInput(request.input);
  const instanceId = expectInstanceId(request.pathParams.instanceId);
  const instance = await findInstance(options, instanceId);
  return [
    { label: "服务器", value: instance.name },
    { label: "上限", value: String(input.limit), unit: "行" },
  ];
}

function presentLogsResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  if (typeof result.content === "string") {
    const count = result.content.split("\n").filter((line) => /^\d+: \[/u.test(line)).length;
    return [{ value: String(count), unit: "行" }];
  }
  const content = result.content;
  const items =
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    Array.isArray(content.items)
      ? content.items
      : [];
  return [{ value: String(items.length), unit: "行" }];
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
  if (options.getRuntime(input.instanceId).state !== "running") {
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

/** 运行状态只暴露 Agent 回答问题所需字段，PID 与宿主资源保持在领域组件内部。 */
function projectRuntime(
  instance: ServerInstanceSnapshot,
  snapshot: ServerRuntimeSnapshot,
): JsonObject {
  const projected: JsonObject = {
    instanceId: instance.id,
    name: instance.name,
    state: snapshot.state,
    acceptingCommands: snapshot.state === "running",
  };
  if (snapshot.startedAt) projected.startedAt = snapshot.startedAt;
  if (snapshot.stoppedAt) projected.stoppedAt = snapshot.stoppedAt;
  if (snapshot.exitCode !== undefined) projected.exitCode = snapshot.exitCode;
  if (snapshot.error) projected.error = snapshot.error;
  return projected;
}

function paginateLogs(lines: readonly ServerConsoleLine[], input: LogsReadInput): ConsolePage {
  const firstCandidate =
    input.afterSequence === undefined
      ? Math.max(0, lines.length - input.limit)
      : lines.findIndex((line) => line.sequence > input.afterSequence!);
  const start = firstCandidate < 0 ? lines.length : firstCandidate;
  const selected = lines.slice(start, start + input.limit).map(projectConsoleLine);
  const latestSequence = lines.at(-1)?.sequence ?? 0;
  const firstSequence = selected.at(0)?.sequence;
  const lastSequence = selected.at(-1)?.sequence;
  return {
    items: selected,
    ...(firstSequence === undefined ? {} : { firstSequence }),
    ...(lastSequence === undefined ? {} : { lastSequence }),
    earlierLineCount: firstSequence === undefined ? latestSequence : Math.max(0, firstSequence - 1),
    laterLineCount: lastSequence === undefined ? 0 : Math.max(0, latestSequence - lastSequence),
  };
}

function projectConsoleLine(line: ServerConsoleLine): ProjectedConsoleLine {
  if (line.text.length <= maximumAgentLineLength) {
    return {
      sequence: line.sequence,
      stream: line.stream,
      text: line.text,
      timestamp: line.timestamp,
      truncated: false,
    };
  }
  return {
    sequence: line.sequence,
    stream: line.stream,
    text: line.text.slice(0, maximumAgentLineLength),
    timestamp: line.timestamp,
    truncated: true,
  };
}

function projectLogsPage(instance: ServerInstanceSnapshot, page: ConsolePage): JsonObject {
  const pagination: JsonObject = {
    earlierLineCount: page.earlierLineCount,
    laterLineCount: page.laterLineCount,
  };
  if (page.firstSequence !== undefined) pagination.firstSequence = page.firstSequence;
  if (page.lastSequence !== undefined) pagination.lastSequence = page.lastSequence;
  return {
    instanceId: instance.id,
    name: instance.name,
    items: page.items.map((line) => ({ ...line })),
    pagination,
  };
}

function formatRuntimeText(runtime: JsonObject): string {
  const lines = formatInstanceIdentity(runtime);
  lines.push(`State: ${expectOutputString(runtime.state, "state")}`);
  lines.push(`Accepting commands: ${runtime.acceptingCommands === true ? "yes" : "no"}`);
  appendOptionalLine(lines, "Started at", runtime.startedAt);
  appendOptionalLine(lines, "Stopped at", runtime.stoppedAt);
  if (typeof runtime.exitCode === "number") lines.push(`Exit code: ${runtime.exitCode}`);
  appendOptionalLine(lines, "Error", runtime.error);
  return lines.join("\n");
}

function formatLogsText(instance: ServerInstanceSnapshot, page: ConsolePage): string {
  const lines = [`Server name: ${instance.name}`, `Instance ID: ${instance.id}`];
  if (page.items.length === 0) {
    lines.push("No console logs found.");
    return lines.join("\n");
  }
  if (page.earlierLineCount > 0) {
    lines.push(`${page.earlierLineCount} earlier lines omitted`);
  }
  for (const line of page.items) {
    lines.push(
      `${line.sequence}: [${formatLogTimestamp(line.timestamp)}][${line.stream}] ${line.text}${
        line.truncated ? "... [truncated]" : ""
      }`,
    );
  }
  if (page.laterLineCount > 0) {
    lines.push(`${page.laterLineCount} later lines omitted`);
  }
  return lines.join("\n");
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

function formatCommandText(output: JsonObject): string {
  const lines = formatInstanceIdentity(output);
  lines.push(`Command accepted: ${output.accepted === true ? "yes" : "no"}`);
  lines.push(
    `Command log sequence: ${expectOutputNumber(output.commandLogSequence, "commandLogSequence")}`,
  );
  return lines.join("\n");
}

function formatInstanceIdentity(value: JsonObject): string[] {
  return [
    `Server name: ${expectOutputString(value.name, "name")}`,
    `Instance ID: ${expectOutputString(value.instanceId, "instanceId")}`,
  ];
}

function appendOptionalLine(lines: string[], label: string, value: JsonValue | undefined): void {
  if (typeof value === "string") lines.push(`${label}: ${value}`);
}

function formatLogTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, "");
}

async function findInstance(
  options: ServerRuntimeAgentRegistrationOptions,
  instanceId: string,
): Promise<ServerInstanceSnapshot> {
  const instance = (await options.listInstances()).find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error(`server instance ${instanceId} was not found`);
  return instance;
}

function parseRuntimeReadInput(value: JsonValue, label: string): RuntimeReadInput {
  const input = expectObject(value, label, ["json"]);
  return { json: readOptionalBoolean(input.json, `${label} json`) ?? false };
}

function parseLogsReadInput(value: JsonValue): LogsReadInput {
  const input = expectObject(value, "服务器日志资源", ["afterSequence", "limit", "json"]);
  const afterSequence = readOptionalNonNegativeInteger(
    input.afterSequence,
    "服务器日志资源 afterSequence",
  );
  return {
    ...(afterSequence === undefined ? {} : { afterSequence }),
    limit: readOptionalPositiveInteger(input.limit, "服务器日志资源 limit") ?? defaultLogLimit,
    json: readOptionalBoolean(input.json, "服务器日志资源 json") ?? false,
  };
}

function parseRuntimeToolInput(value: JsonValue, label: string): RuntimeToolInput {
  const input = expectObject(value, label, ["instanceId", "json"]);
  return {
    instanceId: expectInstanceId(input.instanceId),
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

function expectObject(value: JsonValue, label: string, allowedKeys: readonly string[]): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} input 必须是对象`);
  }
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new TypeError(`${label} 不支持参数 ${unknownKey}`);
  return value;
}

function expectInstanceId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError("server runtime instance id must be a plain identifier");
  }
  return value;
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

function readOptionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

function readOptionalNonNegativeInteger(
  value: JsonValue | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} 必须是非负安全整数`);
  }
  return value;
}

function readOptionalPositiveInteger(
  value: JsonValue | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumLogLimit
  ) {
    throw new TypeError(`${label} 必须是 1～${maximumLogLimit} 的安全整数`);
  }
  return value;
}

function expectOutputString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}

function expectOutputNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}
