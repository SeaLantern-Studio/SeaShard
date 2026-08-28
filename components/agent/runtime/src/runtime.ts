import type {
  AgentActivityPresentation,
  AgentConfiguredModel,
  AgentConversationMode,
  AgentInteractionResponse,
  AgentInteractionResponseInput,
  AgentPendingInteraction,
  AgentPermissionMode,
  AgentInvocationReference,
  AgentInvocationSnapshot,
  AgentInvocationState,
  AgentMessageContentBlock,
  AgentModelConfigurationSnapshot,
  AgentModelConnectionModel,
  AgentModelConnectionMutation,
  AgentModelSelection,
  AgentProviderResponseDetails,
  AgentSessionSnapshot,
  AgentSessionSummary,
  AgentTokenUsage,
  AgentToolCallSnapshot,
  AgentUserMessage,
} from "@seashard/contracts";
import { defaultAgentModelReasoningLevels } from "@seashard/contracts";
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
import type {
  AssistantMessage,
  Context,
  ModelsSimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentModelCatalog } from "./model-config";
import type {
  AgentCredentialSource,
  AgentProviderTypeSource,
  ResolvedAgentModel,
} from "./model-config/types";
import { AgentSessionJournal } from "./session-journal";
import type { LoadedAgentSession } from "./session-journal/records";
import { AgentSessionLocalStore, bindAgentLocalResource } from "./local-resource";
import { bindAgentHelpResource } from "./help-resource";
import { AgentOutputCollector } from "./output-collector";
import type { AgentSettingsSource } from "./settings";
import {
  askToolName,
  parseAskToolInput,
  parseTodoToolInput,
  requiresToolConfirmation,
  todoToolName,
} from "./runtime/interactions";
import {
  addTokenUsage,
  assistantText,
  createPiToolResult,
  projectAssistantContent,
  projectInvocation,
  projectModelMessages,
  projectProviderContent,
  projectProviderDetails,
  projectTokenUsage,
} from "./runtime/messages";
import {
  createPiTools,
  indexToolDefinitions,
  parseResourceReadInput,
  safelyPresentAgentResource,
} from "./runtime/tools";
import {
  createConversationTitlePrompt,
  normalizeConversationTitle,
  shouldRefreshConversationTitle,
  type ConversationTitleSummarySource,
} from "./runtime/title-summary";
import {
  cloneInvocation,
  createAbortError,
  errorMessage,
  isAbortError,
  requireJsonValue,
  validateInteractionResponseInput,
  validatePermissionMode,
  validateConversationMode,
  validateIdentifier,
  validateUserMessage,
} from "./runtime/validation";

const maximumAgentSteps = 6;

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

interface RunningInteraction {
  readonly snapshot: AgentPendingInteraction;
  respond(response: AgentInteractionResponse): void;
}

interface ConversationTitleSummaryPlan {
  readonly source: ConversationTitleSummarySource;
  readonly model: ResolvedAgentModel;
}
interface RunningInvocation {
  snapshot: AgentInvocationSnapshot;
  readonly mode: AgentConversationMode;
  readonly permissionMode: AgentPermissionMode;
  readonly controller: AbortController;
  readonly resolvedModel: ResolvedAgentModel;
  readonly toolDefinitions: ReadonlyMap<string, AgentRuntimeTool>;
  readonly resources: AgentRuntimeResourceSnapshot;
  readonly outputCollector: AgentOutputCollector;
  readonly hasTools: boolean;
  readonly tools: readonly Tool[];
  readonly userText: string;
  readonly titleSummary?: ConversationTitleSummaryPlan;
  interaction?: RunningInteraction;
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
  readonly settingsSource?: AgentSettingsSource;
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
  private readonly settingsSource?: AgentSettingsSource;
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
    this.settingsSource = options.settingsSource;
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
    permissionMode?: AgentPermissionMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference> {
    this.assertAvailable();
    const text = validateUserMessage(input.initialMessage);
    const mode = validateConversationMode(input.mode);
    const resolvedModel = await this.models.resolve(input.model);
    const session = await this.journal.create(resolvedModel.selection);
    try {
      return await this.beginInvocation(
        session,
        text,
        mode,
        validatePermissionMode(input.permissionMode),
        resolvedModel,
      );
    } catch (error) {
      await this.journal.delete(session.header.id).catch(this.reportError);
      throw error;
    }
  }

  async sendMessage(input: {
    sessionId: string;
    message: AgentUserMessage;
    mode: AgentConversationMode;
    permissionMode?: AgentPermissionMode;
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
      validatePermissionMode(input.permissionMode),
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

  async respondToInteraction(input: AgentInteractionResponseInput): Promise<void> {
    this.assertAvailable();
    const normalized = validateInteractionResponseInput(input);
    const invocation = this.running.get(normalized.invocationId);
    if (!invocation) throw new Error(`Agent Invocation 没有运行：${normalized.invocationId}`);
    const interaction = invocation.interaction;
    if (!interaction) throw new Error("当前 Agent Invocation 没有等待用户交互");
    interaction.respond(normalized.response);
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
    permissionMode: AgentPermissionMode,
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
    const titleSummary = await this.prepareConversationTitleSummary(
      session,
      resolvedModel.selection,
    );

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
      contentBlocks: [],
    });
    const snapshot: AgentInvocationSnapshot = {
      id: invocationId,
      sessionId: session.header.id,
      state: "running",
      model: { ...resolvedModel.selection },
      startedAt,
      text: "",
      contentBlocks: [],
      toolCalls: [],
    };
    const controller = new AbortController();
    const tools = createPiTools(toolDefinitions.values(), resources);
    const running: RunningInvocation = {
      snapshot,
      mode,
      permissionMode,
      controller,
      resolvedModel,
      toolDefinitions,
      resources,
      outputCollector,
      hasTools: tools.length > 0,
      tools,
      userText: text,
      ...(titleSummary ? { titleSummary } : {}),
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

  /**
   * 标题刷新计划在主调用启动前确定。轮次只由已持久化的用户消息推导，
   * 因此应用重启后仍会落在同一组 3–5 轮边界上，无需另建游标状态。
   */
  private async prepareConversationTitleSummary(
    session: LoadedAgentSession,
    selection: AgentModelSelection,
  ): Promise<ConversationTitleSummaryPlan | undefined> {
    if (!this.settingsSource) return undefined;
    try {
      const settings = await this.settingsSource.get();
      if (!settings.automaticConversationSummary) return undefined;
      const turnNumber = session.messages.filter((message) => message.role === "user").length + 1;
      const source =
        turnNumber === 1
          ? "user-question"
          : shouldRefreshConversationTitle(session.header.id, turnNumber)
            ? "assistant-answer"
            : undefined;
      if (!source) return undefined;

      const configured = (await this.models.list()).find(
        (model) =>
          model.connectionId === selection.connectionId && model.modelId === selection.modelId,
      );
      const lowestReasoningLevel =
        configured?.settings?.reasoningLevels[0] ?? defaultAgentModelReasoningLevels[0];
      const model = await this.models.resolve({
        connectionId: selection.connectionId,
        modelId: selection.modelId,
        reasoningLevel: lowestReasoningLevel,
      });
      return { source, model };
    } catch (error) {
      // 自动标题属于伴随能力；设置损坏或模型配置变化都不能阻断用户的主对话。
      this.reportError(error);
      return undefined;
    }
  }

  /**
   * 总结调用只接收本轮指定来源，不复用对话上下文、工具和资源。
   * 首轮任务会与主调用并行；标题落盘后同步写入运行快照，让客户端轮询立即取得结果。
   */
  private async tryUpdateConversationTitle(
    invocation: RunningInvocation,
    plan: ConversationTitleSummaryPlan,
    content: string,
  ): Promise<void> {
    if (content.trim().length === 0) return;
    try {
      const context: Context = {
        messages: [
          {
            role: "user",
            content: createConversationTitlePrompt(plan.source, content),
            timestamp: Date.now(),
          },
        ],
      };
      const options = {
        ...(plan.model.requestOptions as ModelsSimpleStreamOptions | undefined),
        signal: invocation.controller.signal,
        sessionId: `${invocation.snapshot.sessionId}:title-summary`,
        ...(plan.model.reasoning ? { reasoning: plan.model.reasoning } : {}),
      } satisfies ModelsSimpleStreamOptions;
      const stream = plan.model.models.streamSimple(plan.model.model, context, options);
      let finalMessage: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "done") {
          finalMessage = event.message;
        } else if (event.type === "error") {
          finalMessage = event.error;
        }
      }
      if (!finalMessage) throw new Error("标题总结模型流在返回最终消息前结束");
      if (finalMessage.stopReason === "aborted") return;
      if (finalMessage.stopReason === "error") {
        throw new Error(finalMessage.errorMessage ?? "标题总结失败");
      }
      const title = normalizeConversationTitle(
        assistantText(projectAssistantContent(finalMessage.content)),
      );
      if (title) {
        await this.journal.rename(invocation.snapshot.sessionId, title);
        invocation.snapshot = { ...invocation.snapshot, sessionTitle: title };
        this.invocations.set(invocation.snapshot.id, invocation.snapshot);
      }
    } catch (error) {
      if (!invocation.controller.signal.aborted && !isAbortError(error)) {
        this.reportError(error);
      }
    }
  }

  private async runInvocation(invocation: RunningInvocation): Promise<void> {
    let usage: AgentTokenUsage | undefined;
    let provider: AgentProviderResponseDetails | undefined;
    let contextTokens: number | undefined;
    const initialTitleTask =
      invocation.titleSummary?.source === "user-question"
        ? this.tryUpdateConversationTitle(invocation, invocation.titleSummary, invocation.userText)
        : Promise.resolve();
    try {
      const session = await this.journal.get(invocation.snapshot.sessionId);
      const agentMode = invocation.mode === "agent" && invocation.hasTools;
      const context: Context = {
        messages: projectModelMessages(session, invocation.resolvedModel.model),
        ...(agentMode ? { tools: [...invocation.tools] } : {}),
      };
      const completedBlocks: AgentMessageContentBlock[] = [];
      // 文本偏移独立累计，避免流式快照已经包含当前步骤的尾部文本时把工具排到末尾。
      let completedAssistantTextLength = 0;

      for (let step = 0; step < maximumAgentSteps; step += 1) {
        const message = await this.streamModelStep(invocation, context, completedBlocks);
        const toolCalls: Array<{
          readonly call: ToolCall;
          readonly assistantTextOffset: number;
        }> = [];
        let stepAssistantTextLength = 0;
        for (const block of message.content) {
          if (block.type === "text") {
            stepAssistantTextLength += block.text.length;
            continue;
          }
          if (block.type === "toolCall") {
            toolCalls.push({
              call: block,
              assistantTextOffset: completedAssistantTextLength + stepAssistantTextLength,
            });
          }
        }
        const stepBlocks = projectAssistantContent(message.content);
        completedBlocks.push(...stepBlocks);
        completedAssistantTextLength += stepAssistantTextLength;
        provider = projectProviderDetails(message);
        const stepUsage = projectTokenUsage(message.usage);
        usage = addTokenUsage(usage, stepUsage);
        this.updateInvocationContent(invocation, completedBlocks, provider, usage);
        await this.journal.appendMessage({
          sessionId: invocation.snapshot.sessionId,
          invocationId: invocation.snapshot.id,
          role: "assistant",
          content: assistantText(stepBlocks),
          contentBlocks: stepBlocks,
          provider,
          usage: stepUsage,
          providerContent: projectProviderContent(message.content),
        });
        context.messages.push(message);

        if (message.stopReason === "aborted") throw createAbortError("调用已取消");
        if (message.stopReason === "error") {
          throw new Error(message.errorMessage ?? "模型调用失败");
        }
        // 只有供应商确认成功且满足 Journal 约束的整数才更新上下文占用。
        // 异常值保持上一份可信统计，避免 JSON 序列化后让整个 Session 无法读取。
        const confirmedContextTokens = message.usage.totalTokens;
        if (Number.isSafeInteger(confirmedContextTokens) && confirmedContextTokens >= 0) {
          contextTokens = confirmedContextTokens;
        }
        if (!agentMode || toolCalls.length === 0) break;
        for (const { call, assistantTextOffset } of toolCalls) {
          if (invocation.controller.signal.aborted) throw createAbortError("调用已取消");
          context.messages.push(await this.executeToolCall(invocation, call, assistantTextOffset));
          // 工具可能在执行期间收到取消。立即结束本批次，禁止继续分派后续副作用。
          if (invocation.controller.signal.aborted) throw createAbortError("调用已取消");
        }
      }

      const text = assistantText(completedBlocks);
      if (invocation.titleSummary?.source === "assistant-answer") {
        await this.tryUpdateConversationTitle(invocation, invocation.titleSummary, text);
      }
      await initialTitleTask;
      await this.finishInvocation(
        invocation,
        "completed",
        text,
        completedBlocks,
        provider,
        usage,
        undefined,
        contextTokens,
      );
    } catch (error) {
      await initialTitleTask;
      const cancelled = invocation.controller.signal.aborted || isAbortError(error);
      const message = cancelled ? "调用已取消" : errorMessage(error);
      await this.finishOpenToolCalls(invocation, cancelled ? "cancelled" : "failed", message);
      await this.finishInvocation(
        invocation,
        cancelled ? "cancelled" : "failed",
        invocation.snapshot.text,
        invocation.snapshot.contentBlocks,
        provider,
        usage,
        cancelled ? undefined : message,
        contextTokens,
      );
      if (!cancelled) this.reportError(error);
    }
  }

  private async streamModelStep(
    invocation: RunningInvocation,
    context: Context,
    completedBlocks: readonly AgentMessageContentBlock[],
  ): Promise<AssistantMessage> {
    const options = {
      ...(invocation.resolvedModel.requestOptions as ModelsSimpleStreamOptions | undefined),
      signal: invocation.controller.signal,
      sessionId: invocation.snapshot.sessionId,
      ...(invocation.resolvedModel.reasoning
        ? { reasoning: invocation.resolvedModel.reasoning }
        : {}),
    } satisfies ModelsSimpleStreamOptions;
    const stream = invocation.resolvedModel.models.streamSimple(
      invocation.resolvedModel.model,
      context,
      options,
    );
    let finalMessage: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "done") {
        finalMessage = event.message;
        continue;
      }
      if (event.type === "error") {
        finalMessage = event.error;
        continue;
      }
      this.updateInvocationContent(invocation, [
        ...completedBlocks,
        ...projectAssistantContent(event.partial.content),
      ]);
    }
    if (!finalMessage) throw new Error("模型流在返回最终消息前结束");
    return finalMessage;
  }

  private updateInvocationContent(
    invocation: RunningInvocation,
    contentBlocks: readonly AgentMessageContentBlock[],
    provider = invocation.snapshot.provider,
    usage = invocation.snapshot.usage,
  ): void {
    invocation.snapshot = {
      ...invocation.snapshot,
      text: assistantText(contentBlocks),
      contentBlocks: structuredClone(contentBlocks),
      ...(provider ? { provider } : {}),
      ...(usage ? { usage } : {}),
    };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
  }
  /** 工具定义只交给模型；执行、严格校验和生命周期全部由 SeaShard 保持控制。 */
  private async executeToolCall(
    invocation: RunningInvocation,
    call: ToolCall,
    assistantTextOffset: number,
  ): Promise<ToolResultMessage<JsonValue>> {
    const input = requireJsonValue(call.arguments, `工具 ${call.name} 输入`);
    await this.startToolCall(invocation, {
      id: call.id,
      toolName: call.name,
      input,
      assistantTextOffset,
    });
    try {
      if (invocation.controller.signal.aborted) throw createAbortError("调用已取消");
      const output =
        call.name === askToolName
          ? await this.executeAskTool(invocation, call.id, input)
          : call.name === todoToolName
            ? this.executeTodoTool(invocation, input)
            : call.name === "read"
              ? await this.executeResourceRead(invocation, call.id, input)
              : await this.executeRegisteredTool(invocation, call, input);
      await this.finishToolCall(invocation, call.id, "completed", output);
      return createPiToolResult(call, output, false);
    } catch (error) {
      const cancelled = invocation.controller.signal.aborted || isAbortError(error);
      const message = cancelled ? "调用已取消" : errorMessage(error);
      await this.finishToolCall(
        invocation,
        call.id,
        cancelled ? "cancelled" : "failed",
        undefined,
        message,
      );
      return createPiToolResult(call, message, true);
    }
  }

  private async executeRegisteredTool(
    invocation: RunningInvocation,
    call: ToolCall,
    input: JsonValue,
  ): Promise<JsonValue> {
    const entry = invocation.toolDefinitions.get(call.name);
    if (!entry) throw new Error(`Agent 工具不存在：${call.name}`);
    await this.confirmRegisteredTool(invocation, call, entry, input);
    const output = await entry.execute(input, { signal: invocation.controller.signal });
    return invocation.outputCollector.collect(output, call.id, invocation.controller.signal);
  }

  private async executeAskTool(
    invocation: RunningInvocation,
    toolCallId: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const ask = parseAskToolInput(input);
    const response = await this.waitForInteraction(invocation, {
      id: randomUUID(),
      invocationId: invocation.snapshot.id,
      toolCallId,
      type: "ask",
      question: ask.question,
      options: ask.options,
      createdAt: new Date().toISOString(),
    });
    if (response.type === "ask-option") {
      return {
        answer: ask.options[response.optionIndex]!,
        source: "option",
      };
    }
    if (response.type === "ask-custom") {
      return { answer: response.value, source: "custom" };
    }
    throw new Error("Agent Ask 收到了不匹配的交互响应");
  }

  private executeTodoTool(invocation: RunningInvocation, input: JsonValue): JsonValue {
    const items = parseTodoToolInput(input);
    const todo = {
      items: structuredClone(items),
      updatedAt: new Date().toISOString(),
    };
    invocation.snapshot = { ...invocation.snapshot, todo };
    this.invocations.set(invocation.snapshot.id, invocation.snapshot);
    const completed = items.filter(({ status }) => status === "completed").length;
    const current =
      items.find(({ status }) => status === "in_progress") ??
      items.find(({ status }) => status === "pending");
    return {
      completed,
      total: items.length,
      current: current?.content ?? null,
    };
  }

  private async confirmRegisteredTool(
    invocation: RunningInvocation,
    call: ToolCall,
    entry: AgentRuntimeTool,
    input: JsonValue,
  ): Promise<void> {
    const confirmationLevel = entry.definition.confirmationLevel;
    if (!requiresToolConfirmation(invocation.permissionMode, confirmationLevel)) return;
    const response = await this.waitForInteraction(invocation, {
      id: randomUUID(),
      invocationId: invocation.snapshot.id,
      toolCallId: call.id,
      type: "tool-confirmation",
      toolName: call.name,
      title: entry.definition.title,
      confirmationLevel,
      input: structuredClone(input),
      createdAt: new Date().toISOString(),
    });
    if (response.type !== "tool-confirmation") {
      throw new Error("Agent 工具确认收到了不匹配的交互响应");
    }
    if (!response.approved) throw new Error(`用户拒绝执行工具：${entry.definition.title}`);
  }

  /**
   * Interaction 只保存在运行中快照。回答或取消会同步清理，Session Journal 继续只记录
   * 模型消息与工具结果，避免把尚未结算的 UI 状态写成可回放历史。
   */
  private waitForInteraction(
    invocation: RunningInvocation,
    snapshot: AgentPendingInteraction,
  ): Promise<AgentInteractionResponse> {
    if (invocation.interaction) throw new Error("当前 Agent Invocation 已在等待用户交互");
    return new Promise<AgentInteractionResponse>((resolve, reject) => {
      const signal = invocation.controller.signal;
      let runningInteraction!: RunningInteraction;
      const clear = () => {
        signal.removeEventListener("abort", abort);
        if (invocation.interaction !== runningInteraction) return;
        invocation.interaction = undefined;
        const { interaction: _interaction, ...nextSnapshot } = invocation.snapshot;
        invocation.snapshot = nextSnapshot;
        this.invocations.set(nextSnapshot.id, nextSnapshot);
      };
      const abort = () => {
        clear();
        reject(createAbortError("调用已取消"));
      };
      runningInteraction = {
        snapshot,
        respond: (response) => {
          this.assertInteractionResponse(snapshot, response);
          clear();
          resolve(response);
        },
      };
      invocation.interaction = runningInteraction;
      invocation.snapshot = { ...invocation.snapshot, interaction: structuredClone(snapshot) };
      this.invocations.set(invocation.snapshot.id, invocation.snapshot);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  private assertInteractionResponse(
    interaction: AgentPendingInteraction,
    response: AgentInteractionResponse,
  ): void {
    if (response.interactionId !== interaction.id) {
      throw new Error("Agent 交互响应与当前请求不匹配");
    }
    if (interaction.type === "tool-confirmation") {
      if (response.type !== "tool-confirmation") {
        throw new TypeError("命令确认只能接收确认或拒绝");
      }
      return;
    }
    if (response.type === "ask-custom") return;
    if (
      response.type !== "ask-option" ||
      response.optionIndex < 0 ||
      response.optionIndex >= interaction.options.length
    ) {
      throw new TypeError("Agent Ask 选项响应不合法");
    }
  }

  private async executeResourceRead(
    invocation: RunningInvocation,
    toolCallId: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const request = parseResourceReadInput(input);
    const prepared = invocation.resources.prepare(request.path, request.input);
    const requestPayload = await safelyPresentAgentResource(
      () => prepared.presentRequest(),
      this.reportError,
    );
    const definition = prepared.definition.presentation;
    let presentation: AgentActivityPresentation = {
      title: definition?.title ?? defaultAgentResourcePresentationTitle,
      ...(definition?.icon ? { icon: definition.icon } : {}),
      ...(requestPayload === undefined ? {} : { requestPayload }),
    };
    await this.updateToolCallPresentation(invocation, toolCallId, presentation);
    const result = await prepared.read({ signal: invocation.controller.signal });
    const resultPayload = await safelyPresentAgentResource(
      () => prepared.presentResult(result),
      this.reportError,
    );
    presentation = resultPayload === undefined ? presentation : { ...presentation, resultPayload };
    await this.updateToolCallPresentation(invocation, toolCallId, presentation);
    return invocation.outputCollector.collect(
      result.content,
      toolCallId,
      invocation.controller.signal,
    );
  }

  private async startToolCall(
    invocation: RunningInvocation,
    call: {
      readonly id: string;
      readonly toolName: string;
      readonly input: JsonValue;
      readonly assistantTextOffset: number;
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
            call.toolName === askToolName
              ? "向用户提问"
              : call.toolName === todoToolName
                ? "更新 TODO"
                : call.toolName === "read"
                  ? "读取资源"
                  : (invocation.toolDefinitions.get(call.toolName)?.definition.title ??
                    call.toolName),
        } satisfies AgentActivityPresentation),
      state: "running",
      input: call.input,
      assistantTextOffset: call.assistantTextOffset,
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
    contentBlocks: readonly AgentMessageContentBlock[],
    provider?: AgentProviderResponseDetails,
    usage?: AgentTokenUsage,
    error?: string,
    contextTokens?: number,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.journal.appendInvocation(invocation.snapshot.sessionId, {
      id: invocation.snapshot.id,
      state,
      model: invocation.snapshot.model,
      text,
      contentBlocks,
      ...(provider ? { provider } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    });
    invocation.snapshot = {
      ...invocation.snapshot,
      state,
      text,
      contentBlocks: structuredClone(contentBlocks),
      finishedAt,
      ...(provider ? { provider } : {}),
      ...(usage ? { usage } : {}),
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
