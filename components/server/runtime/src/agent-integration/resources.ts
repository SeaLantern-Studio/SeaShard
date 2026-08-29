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
  type JsonObject,
  type JsonValue,
} from "@seashard/plugin-sdk";
import {
  appendOptionalLine,
  expectInstanceId,
  expectObject,
  expectOutputString,
  findInstance,
  jsonOutputProperty,
  maximumAgentLineLength,
  readOptionalBoolean,
  type ServerRuntimeAgentRegistrationOptions,
} from "./shared";

const defaultLogLimit = 100;
const maximumLogLimit = 200;

interface RuntimeReadInput {
  readonly json: boolean;
}

interface LogsReadInput extends RuntimeReadInput {
  readonly afterSequence?: number;
  readonly limit: number;
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

export function createServerRuntimeResource(
  options: ServerRuntimeAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取指定 SeaShard 服务器实例的当前进程状态、命令接收能力和本次运行时间信息；结果不包含 PID 或宿主路径。",
    inputSchema: runtimeResourceInputSchema,
    outputDescription: "默认返回英文文本；json=true 时返回结构化运行状态。",
    examples: [{ json: true }],
    help: "启动后使用 server_wait-ready 等待核心就绪；停止后使用 server_wait-stopped 等待进程完全退出。",
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
  const lines = [
    `Server name: ${expectOutputString(runtime.name, "name")}`,
    `Instance ID: ${expectOutputString(runtime.instanceId, "instanceId")}`,
  ];
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

function formatLogTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, "");
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
