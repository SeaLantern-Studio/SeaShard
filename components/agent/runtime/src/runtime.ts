import type {
  AgentConfiguredModel,
  AgentInvocationReference,
  AgentInvocationSnapshot,
  AgentInvocationState,
  AgentModelSelection,
  AgentSessionSnapshot,
  AgentSessionSummary,
  AgentUserMessage,
} from "@seashard/contracts";
import { streamText, type ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { AgentModelCatalog, type ResolvedAgentModel } from "./model-config";
import { AgentSessionJournal, type LoadedAgentSession } from "./session-journal";

const maximumUserMessageLength = 100_000;

interface RunningInvocation {
  snapshot: AgentInvocationSnapshot;
  readonly controller: AbortController;
  readonly resolvedModel: ResolvedAgentModel;
}

export interface AgentRuntimeOptions {
  readonly userDataRoot: string;
  readonly modelCatalog?: AgentModelCatalog;
  readonly reportError?: (error: unknown) => void;
}

/** 第一阶段 Agent 执行内核：模型解析、持久化 Session、文本流与取消。 */
export class AgentRuntime {
  readonly journal: AgentSessionJournal;
  readonly models: AgentModelCatalog;

  private readonly reportError: (error: unknown) => void;
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
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference> {
    this.assertAvailable();
    const text = validateUserMessage(input.initialMessage);
    const resolvedModel = await this.models.resolve(input.model);
    const session = await this.journal.create(resolvedModel.selection);
    try {
      return await this.beginInvocation(session, text, resolvedModel);
    } catch (error) {
      await this.journal.delete(session.header.id).catch(this.reportError);
      throw error;
    }
  }
  async sendMessage(input: {
    sessionId: string;
    message: AgentUserMessage;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference> {
    this.assertAvailable();
    const session = await this.journal.get(validateIdentifier(input.sessionId, "sessionId"));
    const currentModel = session.invocations.at(-1)?.model ?? session.header.model;
    const resolvedModel = await this.models.resolve(input.model ?? currentModel);
    return this.beginInvocation(session, validateUserMessage(input.message), resolvedModel);
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
    resolvedModel: ResolvedAgentModel,
  ): Promise<AgentInvocationReference> {
    const active = this.activeBySession.get(session.header.id);
    if (active) throw new Error(`当前对话已有正在运行的请求：${active}`);

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
    };
    const running: RunningInvocation = {
      snapshot,
      controller: new AbortController(),
      resolvedModel,
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
      const messages: ModelMessage[] = session.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const result = streamText({
        model: invocation.resolvedModel.languageModel,
        messages,
        ...(invocation.resolvedModel.providerOptions
          ? { providerOptions: invocation.resolvedModel.providerOptions }
          : {}),
        abortSignal: invocation.controller.signal,
      });
      for await (const delta of result.textStream) {
        text += delta;
        invocation.snapshot = { ...invocation.snapshot, text };
        this.invocations.set(invocation.snapshot.id, invocation.snapshot);
      }
      if (invocation.controller.signal.aborted) {
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
      await this.finishInvocation(
        invocation,
        cancelled ? "cancelled" : "failed",
        text,
        cancelled ? undefined : errorMessage(error),
      );
      if (!cancelled) this.reportError(error);
    }
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
    ...(last.state === "running" ? {} : { finishedAt: last.timestamp }),
    ...(last.error ? { error: last.error } : {}),
  };
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

function validateIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是字符串`);
  return value;
}

function cloneInvocation(snapshot: AgentInvocationSnapshot): AgentInvocationSnapshot {
  return { ...snapshot, model: { ...snapshot.model } };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
