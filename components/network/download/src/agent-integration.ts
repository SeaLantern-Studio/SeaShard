import {
  defineAgentResource,
  type AgentActivityPresentationField,
  type AgentResource,
  type AgentResourceExecutionContext,
  type AgentResourceReadRequest,
  type AgentResourceReadResult,
  type AgentToolExecutionContext,
  type Awaitable,
  type JsonObject,
  type JsonValue,
  type PluginContext,
} from "@seashard/plugin-sdk";
import { basename } from "node:path";
import type { DownloadTaskSnapshot, DownloadTaskState } from "./types";

const defaultPage = 1;
const defaultPageSize = 20;
const maximumPage = 10_000;
const maximumPageSize = 50;
const maximumTaskIdLength = 128;
const maximumFileNameLength = 255;
const downloadTaskStates = [
  "queued",
  "downloading",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly DownloadTaskState[];
const resourceInputProperties: Readonly<Record<string, true>> = {
  page: true,
  pageSize: true,
  state: true,
};
const cancelInputProperties: Readonly<Record<string, true>> = {
  taskId: true,
};

export interface DownloadAgentRegistrationOptions {
  listTasks(): Awaitable<readonly DownloadTaskSnapshot[]>;
  snapshot(taskId: string): Awaitable<DownloadTaskSnapshot | undefined>;
  cancel(taskId: string): Promise<boolean>;
}

interface DownloadTasksQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly state?: DownloadTaskState;
}

const taskIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: maximumTaskIdLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
  description: "用户可见下载任务 ID；可先读取 download://tasks 获取。",
};

const downloadTasksInputSchema: JsonObject = {
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
      description: "每页最多返回的下载任务数量。",
    },
    state: {
      type: "string",
      enum: [...downloadTaskStates],
      description: "只返回指定状态的任务。",
    },
  },
  additionalProperties: false,
};

const cancelDownloadInputSchema: JsonObject = {
  type: "object",
  properties: { taskId: taskIdProperty },
  required: ["taskId"],
  additionalProperties: false,
};

/**
 * 公共下载组件只向 Agent 发布显式标记为用户可见的任务。
 * 任意 URL、请求头和宿主目标路径继续由下载来源组件决定，不提供通用“开始下载”工具。
 */
export function registerDownloadAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: DownloadAgentRegistrationOptions,
): void {
  context.agentResources({
    "download://tasks": createDownloadTasksResource(options),
  });

  context.agentTool(
    {
      namespace: "download",
      name: "cancel",
      title: "取消下载任务",
      description: "取消一个仍在排队或下载中的用户可见任务，并等待网络传输与临时文件清理结束。",
      confirmationLevel: 1,
      inputSchema: cancelDownloadInputSchema,
      outputDescription:
        "返回任务的安全投影和本次是否实际取消；不会返回远端 URL、请求 metadata 或宿主绝对目标路径。",
      examples: [{ taskId: "550e8400-e29b-41d4-a716-446655440000" }],
    },
    (input, execution) => cancelDownloadTask(options, input, execution),
  );
}

export function createDownloadTasksResource(
  options: DownloadAgentRegistrationOptions,
): AgentResource {
  return defineAgentResource({
    description:
      "读取 SeaShard 当前保留的用户可见下载任务，支持状态筛选和有界分页；结果不包含远端 URL、业务 metadata、错误原文或宿主绝对目标路径。",
    inputSchema: downloadTasksInputSchema,
    outputDescription: "按创建时间从新到旧返回安全任务投影和分页信息，每页最多 50 项。",
    examples: [
      { page: 1, pageSize: 20 },
      { state: "downloading", page: 1, pageSize: 20 },
    ],
    help: "取消仍在运行的任务使用 download_cancel；新建下载必须使用拥有目标资源的领域工具。",
    presentation: { title: "读取下载任务" },
    implementation: {
      read: (request, execution) => readDownloadTasks(options, request, execution),
      presentRequest: presentDownloadTasksRequest,
      presentResult: presentDownloadTasksResult,
    },
  });
}

async function readDownloadTasks(
  options: DownloadAgentRegistrationOptions,
  request: AgentResourceReadRequest,
  execution: AgentResourceExecutionContext,
): Promise<AgentResourceReadResult> {
  execution.signal?.throwIfAborted();
  const query = parseDownloadTasksQuery(request.input);
  const visibleTasks = (await options.listTasks())
    .filter(
      (task) =>
        isUserVisibleDownloadTask(task) &&
        isAgentUsableTaskId(task.id) &&
        (query.state === undefined || task.state === query.state),
    )
    .toReversed();
  execution.signal?.throwIfAborted();

  const start = (query.page - 1) * query.pageSize;
  const items = visibleTasks
    .slice(start, start + query.pageSize)
    .map((task) => projectDownloadTask(task));
  const totalPages = Math.ceil(visibleTasks.length / query.pageSize);
  return {
    mimeType: "application/json",
    content: {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: visibleTasks.length,
        totalPages,
        hasMore: query.page < totalPages,
      },
    },
  };
}

function presentDownloadTasksRequest(
  request: AgentResourceReadRequest,
): readonly AgentActivityPresentationField[] {
  const query = parseDownloadTasksQuery(request.input);
  return [
    { value: `${(query.page - 1) * query.pageSize + 1}～${query.page * query.pageSize}` },
    ...(query.state === undefined
      ? []
      : [{ label: "状态", value: displayDownloadTaskState(query.state) }]),
  ];
}

function presentDownloadTasksResult(
  _request: AgentResourceReadRequest,
  result: AgentResourceReadResult,
): readonly AgentActivityPresentationField[] {
  const content = expectOutputObject(result.content, "下载资源结果");
  const items = content.items;
  if (!Array.isArray(items)) throw new TypeError("Agent 下载资源结果缺少 items");
  return [{ value: String(items.length), unit: "个任务" }];
}

async function cancelDownloadTask(
  options: DownloadAgentRegistrationOptions,
  value: JsonValue,
  execution: AgentToolExecutionContext,
): Promise<JsonValue> {
  execution.signal?.throwIfAborted();
  const taskId = parseCancelDownloadInput(value);
  const task = (await options.listTasks()).find(
    (candidate) => candidate.id === taskId && isUserVisibleDownloadTask(candidate),
  );
  if (!task) throw new Error(`用户可见下载任务不存在：${taskId}`);

  if (isFinishedDownloadState(task.state)) {
    return { task: projectDownloadTask(task), cancelled: false };
  }

  execution.signal?.throwIfAborted();
  const cancelled = await options.cancel(taskId);
  execution.signal?.throwIfAborted();
  const latest = await options.snapshot(taskId);
  const projectedTask =
    latest && isUserVisibleDownloadTask(latest)
      ? projectDownloadTask(latest)
      : projectUnavailableCancelledTask(task, cancelled);
  return { task: projectedTask, cancelled };
}

/** Agent 投影保留任务识别和进度字段；文件名来自最终路径末段，完整路径永不出域。 */
function projectDownloadTask(task: DownloadTaskSnapshot): JsonObject {
  const fileName = basename(task.destinationPath);
  return {
    id: task.id,
    fileName:
      fileName.length <= maximumFileNameLength
        ? fileName
        : `${fileName.slice(0, maximumFileNameLength - 1)}…`,
    fileNameTruncated: fileName.length > maximumFileNameLength,
    state: task.state,
    downloadedBytes: task.downloadedBytes,
    totalBytes: task.totalBytes,
    progress: task.progress,
    connections: task.connections,
    createdAt: task.createdAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    hasError: task.state === "failed",
  };
}

/** 极端保留数为零时，取消完成后任务可能立即被裁剪；此处只修正已经确认的终态。 */
function projectUnavailableCancelledTask(
  task: DownloadTaskSnapshot,
  cancelled: boolean,
): JsonObject {
  const projected = projectDownloadTask(task);
  return cancelled ? { ...projected, state: "cancelled", hasError: false } : projected;
}

function parseDownloadTasksQuery(value: JsonValue): DownloadTasksQuery {
  const input = expectObject(value, "下载任务资源", resourceInputProperties);
  const state = readOptionalDownloadState(input.state);
  return {
    page: readOptionalInteger(input.page, "page", 1, maximumPage) ?? defaultPage,
    pageSize:
      readOptionalInteger(input.pageSize, "pageSize", 1, maximumPageSize) ?? defaultPageSize,
    ...(state === undefined ? {} : { state }),
  };
}

function parseCancelDownloadInput(value: JsonValue): string {
  const input = expectObject(value, "download_cancel", cancelInputProperties);
  return expectTaskId(input.taskId);
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

function expectTaskId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !isAgentUsableTaskId(value)) {
    throw new TypeError("下载任务 ID 必须是长度不超过 128 的普通标识符");
  }
  return value;
}

function isAgentUsableTaskId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isUserVisibleDownloadTask(task: DownloadTaskSnapshot): boolean {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return metadata.userVisible === true;
}

function readOptionalDownloadState(value: JsonValue | undefined): DownloadTaskState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !downloadTaskStates.includes(value as DownloadTaskState)) {
    throw new TypeError("下载任务 state 无效");
  }
  return value as DownloadTaskState;
}

function readOptionalInteger(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} 必须是 ${minimum}～${maximum} 的安全整数`);
  }
  return value;
}

function isFinishedDownloadState(state: DownloadTaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function displayDownloadTaskState(state: DownloadTaskState): string {
  if (state === "queued") return "排队中";
  if (state === "downloading") return "下载中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "失败";
  return "已取消";
}

function expectOutputObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Agent 输出缺少 ${label}`);
  }
  return value;
}
