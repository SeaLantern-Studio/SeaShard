import type {
  AgentConfiguredModel,
  AgentConversationMode,
  AgentInvocationReference,
  AgentInvocationSnapshot,
  AgentInvocationState,
  AgentModelSelection,
  AgentSessionSnapshot,
  AgentSessionSummary,
  AgentToolCallSnapshot,
  AgentUserMessage,
} from "@seashard/contracts";
import type {
  AgentResourceDefinition,
  AgentResourceReadResult,
  AgentToolDefinition,
  AgentToolHandler,
  JsonValue,
} from "@seashard/plugin-sdk";
import {
  APICallError,
  isStepCount,
  jsonSchema,
  RetryError,
  streamText,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { randomUUID } from "node:crypto";
import { AgentModelCatalog, type ResolvedAgentModel } from "./model-config";
import { AgentSessionJournal, type LoadedAgentSession } from "./session-journal";

const maximumUserMessageLength = 100_000;
const maximumAgentSteps = 6;
const toolNamePattern = /^[A-Za-z0-9_-]+$/u;

export interface AgentModelSource {
  initialize(): Promise<void>;
  list(): Promise<readonly AgentConfiguredModel[]>;
  resolve(selection?: AgentModelSelection): Promise<ResolvedAgentModel>;
}

export interface AgentRuntimeTool {
  readonly name: string;
  readonly definition: AgentToolDefinition;
  readonly execute: AgentToolHandler;
}

export interface AgentRuntimeToolSource {
  snapshot(): readonly AgentRuntimeTool[];
}

export interface AgentRuntimeResourceSnapshot {
  readonly definitions: readonly AgentResourceDefinition[];
  read(
    path: string,
    options?: {
      readonly offset?: number;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AgentResourceReadResult>;
}

export interface AgentRuntimeResourceSource {
  snapshot(): AgentRuntimeResourceSnapshot;
}

interface RunningInvocation {
  snapshot: AgentInvocationSnapshot;
  readonly mode: AgentConversationMode;
  readonly controller: AbortController;
  readonly resolvedModel: ResolvedAgentModel;
  readonly toolDefinitions: ReadonlyMap<string, AgentRuntimeTool>;
  readonly hasTools: boolean;
  readonly tools: ToolSet;
}

export interface AgentRuntimeOptions {
  readonly userDataRoot: string;
  readonly modelCatalog?: AgentModelSource;
  readonly toolSource: AgentRuntimeToolSource;
  readonly resourceSource: AgentRuntimeResourceSource;
  readonly reportError?: (error: unknown) => void;
}

/** Agent 执行内核：模型解析、持久化 Session、文本流、工具闭环与取消。 */
export class AgentRuntime {
  readonly journal: AgentSessionJournal;
  readonly models: AgentModelSource;

  private readonly reportError: (error: unknown) => void;
  private readonly toolSource: AgentRuntimeToolSource;
  private readonly resourceSource: AgentRuntimeResourceSource;
  private readonly running = new Map<string, RunningInvocation>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly invocations = new Map<string, AgentInvocationSnapshot>();
  private readonly activeBySession = new Map<string, string>();
  private disposed = false;

  constructor(options: AgentRuntimeOptions) {
    this.models =
      options.modelCatalog ?? new AgentModelCatalog({ userDataRoot: options.userDataRoot });
    this.journal = new AgentSessionJournal(options.userDataRoot);
    this.reportError =
      options.reportError ?? ((error) => console.error("Agent Runtime failed", error));
    this.toolSource = options.toolSource;
    this.resourceSource = options.resourceSource;
  }

  async initialize(): Promise<void> {
    this.assertAvailable();
    await this.models.initialize();
    await this.journal.initialize();
  }

  listModels(): Promise<readonly AgentConfiguredModel[]> {
    this.assertAvailable();
    return this.models.list();
  }

  async startSession(input: {
    initialMessage: AgentUserMessage;
    mode: AgentConversationMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference> {
    this.assertAvailable();
    const text = validateUserMessage(input.initialMessage);
    const mode = validateConversationMode(input.mode);
    const resolvedModel = await this.models.resolve(input.model);
    const session = await this.journal.create(resolvedModel.selection);
    try {
      return await this.beginInvocation(session, text, mode, resolvedModel);
    } catch (error) {
      await this.journal.delete(session.header.id).catch(this.reportError);
      throw error;
    }
  }

  async sendMessage(input: {
    sessionId: string;
    message: AgentUserMessage;
    mode: AgentConversationMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference> {
    this.assertAvailable();
    const session = await this.journal.get(validateIdentifier(input.sessionId, "sessionId"));
    const currentModel = session.invocations.at(-1)?.model ?? session.header.model;
    const resolvedModel = await this.models.resolve(input.model ?? currentModel);
    return this.beginInvocation(
      session,
      validateUserMessage(input.message),
      validateConversationMode(input.mode),
      resolvedModel,
    );
  }

  listSessions(): Promise<readonly AgentSessionSummary[]> {
    this.assertAvailable();
    return this.journal.list();
  }

  getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    this.assertAvailable();
    return this.journal.snapshot(validateIdentifier(sessionId, "sessionId"));
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.assertAvailable();
    await this.journal.rename(validateIdentifier(sessionId, "sessionId"), title);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertAvailable();
    const id = validateIdentifier(sessionId, "sessionId");
    if (this.activeBySession.has(id)) throw new Error("运行中的对话不能删除");
    await this.journal.delete(id);
  }

  async getInvocation(invocationId: string): Promise<AgentInvocationSnapshot> {
    this.assertAvailable();
    const id = validateIdentifier(invocationId, "invocationId");
    const memory = this.running.get(id)?.snapshot ?? this.invocations.get(id);
    if (memory) return cloneInvocation(memory);

    const sessions = await this.journal.list();
    for (const summary of sessions) {
      const session = await this.journal.get(summary.id);
      const snapshot = projectInvocation(session, id);
      if (snapshot) {
        this.invocations.set(id, snapshot);
        return cloneInvocation(snapshot);
      }
    }
    throw new Error(`Agent Invocation 不存在：${id}`);
  }

  async cancelInvocation(invocationId: string): Promise<void> {
    this.assertAvailable();
    const id = validateIdentifier(invocationId, "invocationId");
    const active = this.running.get(id);
    if (active) active.controller.abort("cancelled by caller");
    else await this.getInvocation(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const invocation of this.running.values()) {
      invocation.controller.abort("Agent Runtime is stopping");
    }
    await Promise.allSettled(this.tasks.values());
    this.running.clear();
    this.tasks.clear();
    this.activeBySession.clear();
  }

  private async beginInvocation(
    session: LoadedAgentSession,
    text: string,
    mode: AgentConversationMode,
    resolvedModel: ResolvedAgentModel,
  ): Promise<AgentInvocationReference> {
    const active = this.activeBySession.get(session.header.id);
    if (active) throw new Error(`当前对话已有正在运行的请求：${active}`);
    const toolDefinitions = indexToolDefinitions(this.toolSource.snapshot());
    const resources = this.resourceSource.snapshot();

    const invocationId = randomUUID();
    const startedAt = new Date().toISOString();
    await this.journal.appendMessage({
      sessionId: session.header.id,
      invocationId,
      role: "user",
      content: text,
    });
    await this.journal.appendInvocation(session.header.id, {
      id: invocationId,
      state: "running",
      model: resolvedModel.selection,
      text: "",
    });
    const snapshot: AgentInvocationSnapshot = {
      id: invocationId,
      sessionId: session.header.id,
      state: "running",
      model: { ...resolvedModel.selection },
      startedAt,
      text: "",
      toolCalls: [],
    };
    const running: RunningInvocation = {
      snapshot,
      mode,
      controller: new AbortController(),
      resolvedModel,
      toolDefinitions,
      hasTools: toolDefinitions.size > 0 || resources.definitions.length > 0,
      tools: createToolSet(toolDefinitions.values(), resources),
    };
    this.running.set(invocationId, running);
    this.invocations.set(invocationId, snapshot);
    this.activeBySession.set(session.header.id, invocationId);
    const task = this.runInvocation(running).finally(() => {
      this.running.delete(invocationId);
      this.tasks.delete(invocationId);
      this.activeBySession.delete(session.header.id);
    });
    this.tasks.set(invocationId, task);
    return { sessionId: session.header.id, invocationId };
  }

  private async runInvocation(invocation: RunningInvocation): Promise<void> {
    let text = "";
    try {
      const session = await this.journal.get(invocation.snapshot.sessionId);
      const messages = projectModelMessages(session);
      const agentMode = invocation.mode === "agent" && invocation.hasTools;
      const result = streamText({
        model: invocation.resolvedModel.languageModel,
        messages,
        ...(invocation.resolvedModel.providerOptions
          ? { providerOptions: invocation.resolvedModel.providerOptions }
          : {}),
        ...(agentMode ? { tools: invocation.tools, stopWhen: isStepCount(maximumAgentSteps) } : {}),
        abortSignal: invocation.controller.signal,
      });

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.text;
          this.updateInvocationText(invocation, text);
          continue;
        }
        if (part.type === "tool-call") {
          await this.startToolCall(invocation, {
            id: part.toolCallId,
            toolName: part.toolName,
            input: requireJsonValue(part.input, `工具 ${part.toolName} 输入`),
          });
          continue;
        }
        if (part.type === "tool-result") {
          await this.finishToolCall(
            invocation,
            part.toolCallId,
            "completed",
            requireJsonValue(part.output, `工具 ${part.toolName} 输出`),
          );
          continue;
        }
        if (part.type === "tool-error") {
          await this.finishToolCall(
            invocation,
            part.toolCallId,
            "failed",
            undefined,
            errorMessage(part.error),
          );
          continue;
        }
        if (part.type === "error") throw part.error;
      }

      if (invocation.controller.signal.aborted) {
        await this.finishOpenToolCalls(invocation, "cancelled", "调用已取消");
        await this.finishInvocation(invocation, "cancelled", text);
        return;
      }
      if (text) {
        await this.journal.appendMessage({
          sessionId: invocation.snapshot.sessionId,
          invocationId: invocation.snapshot.id,
          role: "assistant",
          content: text,
        });
      }
      await this.finishInvocation(invocation, "completed", text);
    } catch (error) {
      const cancelled = invocation.controller.signal.aborted || isAbortError(error);
      const message = cancelled ? "调用已取消" : errorMessage(error);
      await this.finishOpenToolCalls(invocation, cancelled ? "cancelled" : "failed", message);
      await this.finishInvocation(
        invocation,
        cancelled ? "cancelled" : "failed",
        text,
        cancelled ? undefined : message,
      );
      if (!cancelled) this.reportError(error);
    }
  }

  private updateInvocationText(invocation: RunningInvocation, text: string): void {
    invocation.snapshot = { ...invocation.snapshot, text };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
  }

  private async startToolCall(
    invocation: RunningInvocation,
    call: { readonly id: string; readonly toolName: string; readonly input: JsonValue },
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const snapshot: AgentToolCallSnapshot = {
      id: call.id,
      invocationId: invocation.snapshot.id,
      toolName: call.toolName,
      title:
        call.toolName === "read"
          ? "读取资源"
          : (invocation.toolDefinitions.get(call.toolName)?.definition.title ?? call.toolName),
      state: "running",
      input: call.input,
      startedAt,
    };
    await this.recordToolCall(invocation, snapshot);
  }

  private async finishToolCall(
    invocation: RunningInvocation,
    toolCallId: string,
    state: "completed" | "failed",
    output?: JsonValue,
    error?: string,
  ): Promise<void> {
    const current = invocation.snapshot.toolCalls.find(({ id }) => id === toolCallId);
    if (!current) throw new Error(`Agent Tool Call 不存在：${toolCallId}`);
    const snapshot: AgentToolCallSnapshot = {
      ...current,
      state,
      ...(output === undefined ? {} : { output }),
      ...(error ? { error } : {}),
      finishedAt: new Date().toISOString(),
    };
    await this.recordToolCall(invocation, snapshot);
  }

  private async finishOpenToolCalls(
    invocation: RunningInvocation,
    state: "cancelled" | "failed",
    error: string,
  ): Promise<void> {
    for (const call of invocation.snapshot.toolCalls) {
      if (call.state !== "running") continue;
      await this.recordToolCall(invocation, {
        ...call,
        state,
        error,
        finishedAt: new Date().toISOString(),
      });
    }
  }

  private async recordToolCall(
    invocation: RunningInvocation,
    snapshot: AgentToolCallSnapshot,
  ): Promise<void> {
    await this.journal.appendToolCall(invocation.snapshot.sessionId, snapshot);
    const exists = invocation.snapshot.toolCalls.some(({ id }) => id === snapshot.id);
    const toolCalls = exists
      ? invocation.snapshot.toolCalls.map((call) => (call.id === snapshot.id ? snapshot : call))
      : [...invocation.snapshot.toolCalls, snapshot];
    invocation.snapshot = { ...invocation.snapshot, toolCalls };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
  }

  private async finishInvocation(
    invocation: RunningInvocation,
    state: Exclude<AgentInvocationState, "running">,
    text: string,
    error?: string,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.journal.appendInvocation(invocation.snapshot.sessionId, {
      id: invocation.snapshot.id,
      state,
      model: invocation.snapshot.model,
      text,
      ...(error ? { error } : {}),
    });
    invocation.snapshot = {
      ...invocation.snapshot,
      state,
      text,
      finishedAt,
      ...(error ? { error } : {}),
    };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Agent Runtime 已停止");
  }
}

function projectInvocation(
  session: LoadedAgentSession,
  invocationId: string,
): AgentInvocationSnapshot | undefined {
  const records = session.invocations.filter((record) => record.id === invocationId);
  const first = records[0];
  const last = records.at(-1);
  if (!first || !last) return undefined;
  return {
    id: invocationId,
    sessionId: session.header.id,
    state: last.state,
    model: { ...last.model },
    startedAt: first.timestamp,
    text: last.text ?? "",
    toolCalls: session.toolCalls.filter((call) => call.invocationId === invocationId),
    ...(last.state === "running" ? {} : { finishedAt: last.timestamp }),
    ...(last.error ? { error: last.error } : {}),
  };
}

/** 按 Invocation 重建工具调用消息，确保后续轮次能看到既有工具结果。 */
function projectModelMessages(session: LoadedAgentSession): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const assistantByInvocation = new Map<string, typeof session.messages>();
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    const group = assistantByInvocation.get(message.invocationId) ?? [];
    assistantByInvocation.set(message.invocationId, [...group, message]);
  }

  for (const message of session.messages) {
    if (message.role !== "user") continue;
    messages.push({ role: "user", content: message.content });
    for (const call of session.toolCalls) {
      if (call.invocationId !== message.invocationId || call.state === "running") continue;
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.toolName,
            input: call.input,
          },
        ],
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.toolName,
            output:
              call.state === "completed"
                ? { type: "json", value: call.output ?? null }
                : { type: "error-text", value: call.error ?? "工具调用未完成" },
          },
        ],
      });
    }
    for (const assistant of assistantByInvocation.get(message.invocationId) ?? []) {
      messages.push({ role: "assistant", content: assistant.content });
    }
  }
  return messages;
}

function indexToolDefinitions(
  definitions: readonly AgentRuntimeTool[],
): ReadonlyMap<string, AgentRuntimeTool> {
  const indexed = new Map<string, AgentRuntimeTool>();
  for (const entry of definitions) {
    if (!toolNamePattern.test(entry.name)) {
      throw new TypeError(`Agent 工具名称不合法：${entry.name}`);
    }
    const expectedName = `${entry.definition.namespace}_${entry.definition.name}`;
    if (entry.name !== expectedName) {
      throw new TypeError(`Agent 工具身份不一致：${entry.name} != ${expectedName}`);
    }
    if (!entry.definition.title.trim() || !entry.definition.description.trim()) {
      throw new TypeError(`Agent 工具缺少标题或描述：${entry.name}`);
    }
    if (indexed.has(entry.name)) throw new TypeError(`Agent 工具名称重复：${entry.name}`);
    indexed.set(entry.name, entry);
  }
  return indexed;
}

function createToolSet(
  definitions: Iterable<AgentRuntimeTool>,
  resources: AgentRuntimeResourceSnapshot,
): ToolSet {
  const tools: ToolSet = {};
  if (resources.definitions.length) {
    const resourceCatalog = formatResourceCatalog(resources.definitions);
    tools.read = tool({
      title: "读取资源",
      description: [
        "读取当前组件声明的只读资源 URI，可按行分页。",
        "只能使用下面列出的 URI 模式；不要猜测或使用列表外的 scheme 和路径。",
        "",
        resourceCatalog,
      ].join("\n"),
      inputSchema: jsonSchema<JsonValue>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `完整资源 URI，必须匹配当前可用模式：\n${resourceCatalog}`,
          },
          offset: { type: "integer", minimum: 1, description: "可选的起始行，第一行为 1" },
          limit: { type: "integer", minimum: 1, description: "可选的最大返回行数" },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async (input, { abortSignal }) => {
        const request = parseResourceReadInput(input);
        return resources.read(request.path, {
          ...(request.offset === undefined ? {} : { offset: request.offset }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          signal: abortSignal,
        });
      },
    });
  }
  for (const entry of definitions) {
    tools[entry.name] = tool({
      title: entry.definition.title,
      description: entry.definition.description,
      inputSchema: jsonSchema<JsonValue>(entry.definition.inputSchema as JSONSchema7),
      execute: async (input, { abortSignal }) =>
        entry.execute(requireJsonValue(input, `工具 ${entry.name} 输入`), {
          signal: abortSignal,
        }),
    });
  }
  return tools;
}

function parseResourceReadInput(value: unknown): {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("read 输入必须是对象");
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  );
  if (unexpected.length) throw new TypeError(`read 包含未知参数：${unexpected.join(", ")}`);
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new TypeError("read.path 必须是非空字符串");
  }
  const offset = parseResourcePageNumber(input.offset, "read.offset");
  const limit = parseResourcePageNumber(input.limit, "read.limit");
  return {
    path: input.path.trim(),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** 把当前 Invocation 真正可用的路径压缩进工具元数据，避免模型猜测 URI。 */
function formatResourceCatalog(definitions: readonly AgentResourceDefinition[]): string {
  return [
    "当前可用资源 URI 模式：",
    ...definitions.map(
      ({ pattern, description }) => `- ${pattern} — ${description.replace(/\s+/gu, " ")}`,
    ),
  ].join("\n");
}

function parseResourcePageNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} 必须是正整数`);
  }
  return value;
}

function validateUserMessage(message: AgentUserMessage): string {
  if (!message || typeof message !== "object" || typeof message.text !== "string") {
    throw new TypeError("Agent 消息必须包含 text");
  }
  const text = message.text.trim();
  if (!text) throw new TypeError("Agent 消息不能为空");
  if (text.length > maximumUserMessageLength) {
    throw new RangeError(`Agent 消息不能超过 ${maximumUserMessageLength} 个字符`);
  }
  return text;
}

function validateConversationMode(value: AgentConversationMode): AgentConversationMode {
  if (value !== "chat" && value !== "agent") throw new TypeError("Agent mode 不合法");
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是字符串`);
  return value;
}

function requireJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => requireJsonValue(entry, label));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        requireJsonValue(entry, `${label}.${key}`),
      ]),
    );
  }
  throw new TypeError(`${label} 必须是 JSON 值`);
}

function cloneInvocation(snapshot: AgentInvocationSnapshot): AgentInvocationSnapshot {
  return {
    ...snapshot,
    model: { ...snapshot.model },
    toolCalls: snapshot.toolCalls.map((call) => ({ ...call })),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  const retry = RetryError.isInstance(error) ? error : undefined;
  const cause = retry?.lastError ?? error;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ? `HTTP ${cause.statusCode}` : "上游请求失败";
    const attempts = retry && retry.errors.length > 1 ? `，共尝试 ${retry.errors.length} 次` : "";
    const responseDetail = apiErrorResponseDetail(cause.responseBody);
    const detail =
      responseDetail && responseDetail !== cause.message
        ? `${cause.message}；${responseDetail}`
        : cause.message;
    return `${status}${attempts}：${detail}`.slice(0, 2_000);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** 只投影结构化错误字段，避免把请求头、凭据或任意 HTML 响应带到 Renderer。 */
function apiErrorResponseDetail(responseBody: string | undefined): string | undefined {
  if (!responseBody) return undefined;
  try {
    const body = JSON.parse(responseBody) as {
      error?: { message?: unknown; type?: unknown; code?: unknown; param?: unknown };
    };
    const error = body.error;
    if (!error || typeof error.message !== "string") return undefined;
    const labels = [error.type, error.code, error.param].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return labels.length > 0 ? `${labels.join("/")}：${error.message}` : error.message;
  } catch {
    return undefined;
  }
}
