import type {
  AgentActivityPresentation,
  AgentConfiguredModel,
  AgentModelConfigurationSnapshot,
  AgentModelConnectionModel,
  AgentModelConnectionMutation,
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
import { interleaveAgentInvocationContent } from "@seashard/contracts";
import { defaultAgentResourcePresentationTitle } from "@seashard/plugin-sdk";
import type {
  AgentActivityPresentationField,
  AgentResourceDefinition,
  AgentResourceExecutionContext,
  AgentResourceReadRequest,
  AgentResourceReadResult,
  AgentToolDefinition,
  AgentToolHandler,
  JsonObject,
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
import { join } from "node:path";
import {
  AgentModelCatalog,
  type AgentCredentialSource,
  type AgentProviderTypeSource,
  type ResolvedAgentModel,
} from "./model-config";
import { AgentSessionJournal, type LoadedAgentSession } from "./session-journal";
import { AgentSessionLocalStore, bindAgentLocalResource } from "./local-resource";
import { bindAgentHelpResource } from "./help-resource";
import { AgentOutputCollector } from "./output-collector";

const maximumUserMessageLength = 100_000;
const maximumAgentSteps = 6;
const toolNamePattern = /^[A-Za-z0-9_-]+$/u;

export interface AgentModelSource {
  initialize(): Promise<void>;
  list(): Promise<readonly AgentConfiguredModel[]>;
  resolve(selection?: AgentModelSelection): Promise<ResolvedAgentModel>;
  dispose?(): Promise<void>;
}

export interface AgentModelConfigurationAccess {
  getConfiguration(): Promise<AgentModelConfigurationSnapshot>;
  mutateConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
    readonly operations: readonly AgentModelConnectionMutation[];
  }): Promise<AgentModelConfigurationSnapshot>;
  removeConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  resetConfiguration(input: {
    readonly expectedRevision: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  discoverModels(input: {
    readonly providerType: string;
    readonly settings: JsonObject;
    readonly credentialId?: string;
    readonly credentialValue?: string;
  }): Promise<readonly AgentModelConnectionModel[]>;
  writeCredential(input: {
    readonly credentialId: string;
    readonly value: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  removeCredential(input: {
    readonly credentialId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  openConfigurationFile(): Promise<void>;
  onConfigurationChanged(listener: (snapshot: AgentModelConfigurationSnapshot) => void): () => void;
}

export interface AgentRuntimeTool {
  readonly name: string;
  readonly definition: AgentToolDefinition;
  readonly execute: AgentToolHandler;
}

export interface AgentRuntimeToolSource {
  snapshot(): readonly AgentRuntimeTool[];
}

export interface AgentRuntimePreparedResourceRead {
  readonly definition: AgentResourceDefinition;
  readonly request: AgentResourceReadRequest;
  presentRequest(): Promise<readonly AgentActivityPresentationField[] | undefined>;
  read(context?: AgentResourceExecutionContext): Promise<AgentResourceReadResult>;
  presentResult(
    result: AgentResourceReadResult,
  ): Promise<readonly AgentActivityPresentationField[] | undefined>;
}

export interface AgentRuntimeResourceSnapshot {
  readonly definitions: readonly AgentResourceDefinition[];
  prepare(path: string, input: JsonValue): AgentRuntimePreparedResourceRead;
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
  readonly modelConfiguration?: AgentModelConfigurationAccess;
  readonly providerTypeSource?: AgentProviderTypeSource;
  readonly credentialSource?: AgentCredentialSource;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly modelConfigWatchDebounceMs?: number;
  readonly openModelConfigurationFile?: (path: string) => Promise<void>;
  readonly toolSource: AgentRuntimeToolSource;
  readonly resourceSource: AgentRuntimeResourceSource;
  readonly reportError?: (error: unknown) => void;
}

/** Agent 执行内核：模型解析、持久化 Session、文本流、工具闭环与取消。 */
export class AgentRuntime {
  readonly journal: AgentSessionJournal;
  readonly models: AgentModelSource;
  readonly modelConfiguration?: AgentModelConfigurationAccess;

  private readonly reportError: (error: unknown) => void;
  private readonly toolSource: AgentRuntimeToolSource;
  private readonly resourceSource: AgentRuntimeResourceSource;
  private readonly running = new Map<string, RunningInvocation>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly invocations = new Map<string, AgentInvocationSnapshot>();
  private readonly activeBySession = new Map<string, string>();
  private disposed = false;

  constructor(options: AgentRuntimeOptions) {
    if (options.modelCatalog) {
      this.models = options.modelCatalog;
      this.modelConfiguration = options.modelConfiguration;
    } else {
      if (!options.providerTypeSource) {
        throw new Error("Agent Runtime 缺少 Provider Type Registry");
      }
      const catalog = new AgentModelCatalog({
        userDataRoot: options.userDataRoot,
        providerTypes: options.providerTypeSource,
        ...(options.credentialSource ? { credentials: options.credentialSource } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.modelConfigWatchDebounceMs === undefined
          ? {}
          : { watchDebounceMs: options.modelConfigWatchDebounceMs }),
        ...(options.openModelConfigurationFile
          ? { openConfigurationFile: options.openModelConfigurationFile }
          : {}),
        ...(options.reportError ? { reportError: options.reportError } : {}),
      });
      this.models = catalog;
      this.modelConfiguration = catalog;
    }
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

  getModelConfiguration(): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().getConfiguration();
  }

  mutateModelConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
    readonly operations: readonly AgentModelConnectionMutation[];
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().mutateConnection(input);
  }

  removeModelConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().removeConnection(input);
  }
  resetModelConfiguration(input: {
    readonly expectedRevision: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().resetConfiguration(input);
  }

  discoverModels(input: {
    readonly providerType: string;
    readonly settings: JsonObject;
    readonly credentialId?: string;
    readonly credentialValue?: string;
  }): Promise<readonly AgentModelConnectionModel[]> {
    this.assertAvailable();
    return this.requireModelConfiguration().discoverModels(input);
  }

  writeModelCredential(input: {
    readonly credentialId: string;
    readonly value: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().writeCredential(input);
  }

  removeModelCredential(input: {
    readonly credentialId: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertAvailable();
    return this.requireModelConfiguration().removeCredential(input);
  }

  openModelConfigurationFile(): Promise<void> {
    this.assertAvailable();
    return this.requireModelConfiguration().openConfigurationFile();
  }

  onModelConfigurationChanged(
    listener: (snapshot: AgentModelConfigurationSnapshot) => void,
  ): () => void {
    this.assertAvailable();
    return this.requireModelConfiguration().onConfigurationChanged(listener);
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
  async copySession(sessionId: string): Promise<AgentSessionSummary> {
    this.assertAvailable();
    const id = validateIdentifier(sessionId, "sessionId");
    if (this.activeBySession.has(id)) throw new Error("运行中的对话不能复制");
    return this.journal.copy(id);
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
    await this.models.dispose?.();
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
    const localStore = new AgentSessionLocalStore(
      join(this.journal.sessionsRoot, session.storageKey),
    );
    const localResources = bindAgentLocalResource(this.resourceSource.snapshot(), localStore);
    const resources = bindAgentHelpResource(localResources, [...toolDefinitions.values()]);
    const outputCollector = new AgentOutputCollector(localStore);

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
    let running!: RunningInvocation;
    const controller = new AbortController();
    const tools = createToolSet(toolDefinitions.values(), resources, outputCollector, {
      start: (call) => this.startToolCall(running, call),
      updatePresentation: (toolCallId, presentation) =>
        this.updateToolCallPresentation(running, toolCallId, presentation),
      finish: (toolCallId, state, output, error, presentation) =>
        this.finishToolCall(running, toolCallId, state, output, error, presentation),
      reportError: this.reportError,
    });
    running = {
      snapshot,
      mode,
      controller,
      resolvedModel,
      toolDefinitions,
      hasTools: toolDefinitions.size > 0 || resources.definitions.length > 0,
      tools,
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
          if (part.toolName === "read") continue;
          await this.startToolCall(invocation, {
            id: part.toolCallId,
            toolName: part.toolName,
            input: requireJsonValue(part.input, `工具 ${part.toolName} 输入`),
          });
          continue;
        }
        if (part.type === "tool-result") {
          if (part.toolName === "read") continue;
          await this.finishToolCall(
            invocation,
            part.toolCallId,
            "completed",
            requireJsonValue(part.output, `工具 ${part.toolName} 输出`),
          );
          continue;
        }
        if (part.type === "tool-error") {
          if (part.toolName === "read") continue;
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
      const contextTokens = calculateDragonHTDevContextTokens((await result.finalStep).usage);

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
      await this.finishInvocation(invocation, "completed", text, undefined, contextTokens);
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
    call: {
      readonly id: string;
      readonly toolName: string;
      readonly input: JsonValue;
      readonly presentation?: AgentActivityPresentation;
    },
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const snapshot: AgentToolCallSnapshot = {
      id: call.id,
      invocationId: invocation.snapshot.id,
      toolName: call.toolName,
      presentation:
        call.presentation ??
        ({
          title:
            call.toolName === "read"
              ? "读取资源"
              : (invocation.toolDefinitions.get(call.toolName)?.definition.title ?? call.toolName),
        } satisfies AgentActivityPresentation),
      state: "running",
      input: call.input,
      assistantTextOffset: invocation.snapshot.text.length,
      startedAt,
    };
    await this.recordToolCall(invocation, snapshot);
  }

  private async updateToolCallPresentation(
    invocation: RunningInvocation,
    toolCallId: string,
    presentation: AgentActivityPresentation,
  ): Promise<void> {
    const current = invocation.snapshot.toolCalls.find(({ id }) => id === toolCallId);
    if (!current) throw new Error(`Agent Tool Call 不存在：${toolCallId}`);
    await this.recordToolCall(invocation, { ...current, presentation });
  }

  private async finishToolCall(
    invocation: RunningInvocation,
    toolCallId: string,
    state: "completed" | "cancelled" | "failed",
    output?: JsonValue,
    error?: string,
    presentation?: AgentActivityPresentation,
  ): Promise<void> {
    const current = invocation.snapshot.toolCalls.find(({ id }) => id === toolCallId);
    if (!current) throw new Error(`Agent Tool Call 不存在：${toolCallId}`);
    const snapshot: AgentToolCallSnapshot = {
      ...current,
      state,
      ...(output === undefined ? {} : { output }),
      ...(error ? { error } : {}),
      ...(presentation === undefined ? {} : { presentation }),
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
    contextTokens?: number,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.journal.appendInvocation(invocation.snapshot.sessionId, {
      id: invocation.snapshot.id,
      state,
      model: invocation.snapshot.model,
      text,
      ...(error ? { error } : {}),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    });
    invocation.snapshot = {
      ...invocation.snapshot,
      state,
      text,
      finishedAt,
      ...(error ? { error } : {}),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
  }

  private requireModelConfiguration(): AgentModelConfigurationAccess {
    if (!this.modelConfiguration) {
      throw new Error("当前 Agent 模型来源不提供结构化配置服务");
    }
    return this.modelConfiguration;
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
    ...(last.contextTokens === undefined ? {} : { contextTokens: last.contextTokens }),
  };
}

/** 按 Invocation 的文本偏移重建消息，确保后续轮次看到原始的文字与工具交错顺序。 */
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
    const assistantText = (assistantByInvocation.get(message.invocationId) ?? [])
      .map(({ content }) => content)
      .join("");
    const calls = session.toolCalls.filter(
      (call) => call.invocationId === message.invocationId && call.state !== "running",
    );
    for (const part of interleaveAgentInvocationContent(assistantText, calls)) {
      if (part.kind === "text") {
        messages.push({ role: "assistant", content: part.content });
        continue;
      }
      const call = part.call;
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

interface AgentResourceToolLifecycle {
  start(call: {
    readonly id: string;
    readonly toolName: "read";
    readonly input: JsonValue;
  }): Promise<void>;
  updatePresentation(toolCallId: string, presentation: AgentActivityPresentation): Promise<void>;
  finish(
    toolCallId: string,
    state: "completed" | "cancelled" | "failed",
    output?: JsonValue,
    error?: string,
    presentation?: AgentActivityPresentation,
  ): Promise<void>;
  reportError(error: unknown): void;
}

function createToolSet(
  definitions: Iterable<AgentRuntimeTool>,
  resources: AgentRuntimeResourceSnapshot,
  outputCollector: AgentOutputCollector,
  resourceLifecycle: AgentResourceToolLifecycle,
): ToolSet {
  const tools: ToolSet = {};
  if (resources.definitions.length) {
    const resourceCatalog = formatResourceCatalog(resources.definitions);
    tools.read = tool({
      title: "读取资源",
      description: [
        "读取当前组件声明的只读资源 URI。每个资源自行定义 input 中的分页、过滤和排序参数。",
        "只能使用下面列出的 URI 模式；不要猜测或使用列表外的 scheme 和路径。",
        "",
        resourceCatalog,
      ].join("\n"),
      inputSchema: jsonSchema<JsonValue>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `完整资源 URI，必须匹配当前可用模式：\n${formatResourcePatterns(
              resources.definitions,
            )}`,
          },
          input: {
            description: "资源专有读取参数，必须符合所选 URI 模式列出的输入 Schema",
          },
        },
        required: ["path", "input"],
        additionalProperties: false,
      }),
      execute: async (input, { abortSignal, toolCallId }) => {
        const callInput = requireJsonValue(input, "读取资源输入");
        await resourceLifecycle.start({
          id: toolCallId,
          toolName: "read",
          input: callInput,
        });
        let presentation: AgentActivityPresentation = {
          title: defaultAgentResourcePresentationTitle,
        };
        try {
          const request = parseResourceReadInput(callInput);
          const prepared = resources.prepare(request.path, request.input);
          const requestPayload = await safelyPresentAgentResource(
            () => prepared.presentRequest(),
            (error) => resourceLifecycle.reportError(error),
          );
          const preparedPresentation = prepared.definition.presentation;
          presentation = {
            title: preparedPresentation?.title ?? defaultAgentResourcePresentationTitle,
            ...(preparedPresentation?.icon ? { icon: preparedPresentation.icon } : {}),
            ...(requestPayload === undefined ? {} : { requestPayload }),
          };
          await resourceLifecycle.updatePresentation(toolCallId, presentation);
          const result = await prepared.read({ signal: abortSignal });
          const resultPayload = await safelyPresentAgentResource(
            () => prepared.presentResult(result),
            (error) => resourceLifecycle.reportError(error),
          );
          presentation =
            resultPayload === undefined ? presentation : { ...presentation, resultPayload };
          const output = await outputCollector.collect(result.content, toolCallId, abortSignal);
          await resourceLifecycle.finish(toolCallId, "completed", output, undefined, presentation);
          return output;
        } catch (error) {
          const cancelled = abortSignal?.aborted || isAbortError(error);
          await resourceLifecycle.finish(
            toolCallId,
            cancelled ? "cancelled" : "failed",
            undefined,
            cancelled ? "调用已取消" : errorMessage(error),
            presentation,
          );
          throw error;
        }
      },
    });
  }
  for (const entry of definitions) {
    tools[entry.name] = tool({
      title: entry.definition.title,
      description: entry.definition.description,
      inputSchema: jsonSchema<JsonValue>(entry.definition.inputSchema as JSONSchema7),
      execute: async (input, { abortSignal, toolCallId }) => {
        const output = await entry.execute(requireJsonValue(input, `工具 ${entry.name} 输入`), {
          signal: abortSignal,
        });
        return outputCollector.collect(output, toolCallId, abortSignal);
      },
    });
  }
  return tools;
}

function parseResourceReadInput(value: JsonValue): {
  readonly path: string;
  readonly input: JsonValue;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("read 输入必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "path" && key !== "input");
  if (unexpected.length) throw new TypeError(`read 包含未知参数：${unexpected.join(", ")}`);
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new TypeError("read.path 必须是非空字符串");
  }
  if (!Object.hasOwn(value, "input")) throw new TypeError("read.input 是必填字段");
  return {
    path: value.path.trim(),
    input: value.input!,
  };
}

async function safelyPresentAgentResource(
  present: () => Promise<readonly AgentActivityPresentationField[] | undefined>,
  reportError: (error: unknown) => void,
): Promise<readonly AgentActivityPresentationField[] | undefined> {
  try {
    return await present();
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/** 把当前 Invocation 真正可用的资源定义写进工具元数据，避免模型猜测路径和 input。 */
function formatResourceCatalog(definitions: readonly AgentResourceDefinition[]): string {
  return [
    "当前可用资源：",
    ...definitions.map((definition) =>
      [
        `- ${definition.pattern} — ${definition.description.replace(/\s+/gu, " ")}`,
        `  输入 Schema：${JSON.stringify(definition.inputSchema)}`,
        ...(definition.examples?.length
          ? [
              `  输入示例：${definition.examples.map((example) => JSON.stringify(example)).join("；")}`,
            ]
          : []),
        ...(definition.outputDescription
          ? [`  返回：${definition.outputDescription.replace(/\s+/gu, " ")}`]
          : []),
      ].join("\n"),
    ),
  ].join("\n");
}

function formatResourcePatterns(definitions: readonly AgentResourceDefinition[]): string {
  return definitions.map(({ pattern }) => `- ${pattern}`).join("\n");
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
    toolCalls: snapshot.toolCalls.map((call) => ({
      ...call,
      presentation: {
        ...call.presentation,
        ...(call.presentation.requestPayload
          ? {
              requestPayload: call.presentation.requestPayload.map((field) => ({ ...field })),
            }
          : {}),
        ...(call.presentation.resultPayload
          ? {
              resultPayload: call.presentation.resultPayload.map((field) => ({ ...field })),
            }
          : {}),
      },
    })),
  };
}

/** 最后一个 Step 的输入已经包含此前消息和工具结果，再加本步输出即为当前上下文占用。 */
function calculateDragonHTDevContextTokens(usage: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}): number | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  ) {
    return undefined;
  }
  return input + output;
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
