import type {
  AgentMessageContentBlock,
  AgentModelSelection,
  AgentProviderResponseDetails,
  AgentSessionSnapshot,
  AgentSessionSummary,
  AgentTokenUsage,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import { appendFile, cp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneSessionRecords } from "./session-journal/clone";
import {
  encodeTitleSlot,
  findLatestDragonHTDevContextTokens,
  latestTimestamp,
  parseHeader,
  parseInvocation,
  parseMessage,
  parseRecord,
  projectMessageRecord,
  projectSummary,
  projectToolCalls,
  tryParseToolCall,
} from "./session-journal/codec";
import { uuidV7 } from "./session-journal/identifiers";
import { projectLatestAgentTodo } from "./runtime/interactions";
import { migrateVersionOneSessions } from "./session-journal/migration";
import {
  sessionVersion,
  titleSlotBytes,
  type AgentJournalMessageRecord,
  type AgentJournalModelContentBlock,
  type InvocationRecord,
  type LoadedAgentSession,
  type SessionHeaderRecord,
  type ToolCallRecord,
} from "./session-journal/records";

export class AgentSessionJournal {
  readonly sessionsRoot: string;

  constructor(private readonly userDataRoot: string) {
    this.sessionsRoot = join(userDataRoot, "agent", "sessions");
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
    await migrateVersionOneSessions(this.sessionsRoot);
  }

  async create(model: AgentModelSelection): Promise<LoadedAgentSession> {
    const id = uuidV7();
    const timestamp = new Date().toISOString();
    const storageKey = `${timestamp.replace(/[:.]/g, "-")}_${id}`;
    const title = "新对话";
    const header: SessionHeaderRecord = {
      type: "session",
      version: sessionVersion,
      id,
      timestamp,
      title,
      model: { ...model },
    };
    await mkdir(join(this.sessionsRoot, storageKey), { recursive: false });
    await writeFile(
      join(this.sessionsRoot, `${storageKey}.jsonl`),
      Buffer.concat([
        encodeTitleSlot(title, timestamp),
        Buffer.from(`${JSON.stringify(header)}\n`, "utf8"),
      ]),
      { flag: "wx", mode: 0o600 },
    );
    return {
      storageKey,
      header,
      title,
      messages: [],
      invocations: [],
      toolCalls: [],
      updatedAt: timestamp,
    };
  }
  /**
   * 复制 Session 时保留消息、模型调用、工具活动与 local:// 文件，
   * 同时重新分配所有结构性 ID，避免两条分支共享 Invocation/Tool Call 身份。
   */
  async copy(sessionId: string): Promise<AgentSessionSummary> {
    const source = await this.get(sessionId);
    const timestamp = new Date().toISOString();
    const id = uuidV7();
    const storageKey = `${timestamp.replace(/[:.]/g, "-")}_${id}`;
    const sourceBytes = await readFile(join(this.sessionsRoot, `${source.storageKey}.jsonl`));
    const lines = sourceBytes.subarray(titleSlotBytes).toString("utf8").trim().split("\n");
    lines.shift();
    const records = cloneSessionRecords(lines.filter(Boolean).map(parseRecord));
    const header: SessionHeaderRecord = {
      type: "session",
      version: sessionVersion,
      id,
      timestamp,
      title: source.title,
      model: { ...source.header.model },
    };
    const targetDirectory = join(this.sessionsRoot, storageKey);
    const targetFile = join(this.sessionsRoot, `${storageKey}.jsonl`);

    try {
      await cp(join(this.sessionsRoot, source.storageKey), targetDirectory, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await writeFile(
        targetFile,
        Buffer.concat([
          encodeTitleSlot(source.title, timestamp),
          Buffer.from(
            `${JSON.stringify(header)}\n${records.map((record) => `${JSON.stringify(record)}\n`).join("")}`,
            "utf8",
          ),
        ]),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await rm(targetFile, { force: true });
      await rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }

    return projectSummary(await this.readByFileName(`${storageKey}.jsonl`));
  }

  async list(): Promise<readonly AgentSessionSummary[]> {
    const names = await readdir(this.sessionsRoot);
    const sessions = await Promise.all(
      names.filter((name) => name.endsWith(".jsonl")).map((name) => this.readByFileName(name)),
    );
    return sessions
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(projectSummary);
  }

  async get(sessionId: string): Promise<LoadedAgentSession> {
    const names = await readdir(this.sessionsRoot);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const session = await this.readByFileName(name);
      if (session.header.id === sessionId) return session;
    }
    throw new Error(`Agent 对话不存在：${sessionId}`);
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = await this.get(sessionId);
    const contextTokens = findLatestDragonHTDevContextTokens(session.invocations);
    const todo = projectLatestAgentTodo(session.toolCalls);
    return {
      ...projectSummary(session),
      messages: session.messages.map(projectMessageRecord),
      toolCalls: session.toolCalls,
      ...(todo === undefined ? {} : { todo }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    };
  }

  async appendMessage(input: {
    readonly sessionId: string;
    readonly invocationId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly contentBlocks?: readonly AgentMessageContentBlock[];
    readonly provider?: AgentProviderResponseDetails;
    readonly usage?: AgentTokenUsage;
    readonly providerContent?: readonly AgentJournalModelContentBlock[];
  }): Promise<AgentJournalMessageRecord> {
    const session = await this.get(input.sessionId);
    const record: AgentJournalMessageRecord = {
      type: "message",
      id: uuidV7(),
      invocationId: input.invocationId,
      role: input.role,
      content: input.content,
      contentBlocks: input.contentBlocks
        ? structuredClone(input.contentBlocks)
        : input.content
          ? [{ type: "text", text: input.content }]
          : [],
      ...(input.provider ? { provider: structuredClone(input.provider) } : {}),
      ...(input.usage ? { usage: structuredClone(input.usage) } : {}),
      ...(input.providerContent ? { providerContent: structuredClone(input.providerContent) } : {}),
      timestamp: new Date().toISOString(),
    };
    await this.appendRecord(session.storageKey, record);
    return record;
  }

  async appendInvocation(
    sessionId: string,
    record: Omit<InvocationRecord, "type" | "timestamp">,
  ): Promise<InvocationRecord> {
    const session = await this.get(sessionId);
    const complete: InvocationRecord = {
      type: "invocation",
      timestamp: new Date().toISOString(),
      ...record,
    };
    await this.appendRecord(session.storageKey, complete);
    return complete;
  }

  /** 工具活动使用同一 toolCallId 追加状态，读取时投影为最后一次状态。 */
  async appendToolCall(
    sessionId: string,
    record: AgentToolCallSnapshot,
  ): Promise<AgentToolCallSnapshot> {
    const session = await this.get(sessionId);
    const complete: ToolCallRecord = {
      type: "tool-call",
      timestamp: new Date().toISOString(),
      ...record,
    };
    await this.appendRecord(session.storageKey, complete);
    return record;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const session = await this.get(sessionId);
    const normalized = title.replace(/\s+/g, " ").trim();
    if (!normalized) throw new TypeError("对话标题不能为空");
    const file = await open(join(this.sessionsRoot, `${session.storageKey}.jsonl`), "r+");
    try {
      await file.write(encodeTitleSlot(normalized, new Date().toISOString()), 0, titleSlotBytes, 0);
    } finally {
      await file.close();
    }
  }

  async delete(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    await rm(join(this.sessionsRoot, `${session.storageKey}.jsonl`), { force: true });
    await rm(join(this.sessionsRoot, session.storageKey), { recursive: true, force: true });
  }

  private async appendRecord(
    storageKey: string,
    record: AgentJournalMessageRecord | InvocationRecord | ToolCallRecord,
  ) {
    await appendFile(
      join(this.sessionsRoot, `${storageKey}.jsonl`),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  private async readByFileName(fileName: string): Promise<LoadedAgentSession> {
    const storageKey = fileName.slice(0, -".jsonl".length);
    const bytes = await readFile(join(this.sessionsRoot, fileName));
    if (bytes.length < titleSlotBytes || bytes[titleSlotBytes - 1] !== 0x0a) {
      throw new Error(`Agent Session 标题槽损坏：${fileName}`);
    }
    const titleRecord = parseRecord(bytes.subarray(0, titleSlotBytes).toString("utf8").trim());
    const lines = bytes.subarray(titleSlotBytes).toString("utf8").trim().split("\n");
    const header = parseHeader(lines.shift(), fileName);
    const messages: AgentJournalMessageRecord[] = [];
    const invocations: InvocationRecord[] = [];
    const toolCallRecords: ToolCallRecord[] = [];
    let updatedAt = latestTimestamp(
      header.timestamp,
      typeof titleRecord.updatedAt === "string" ? titleRecord.updatedAt : undefined,
    );
    for (const line of lines) {
      const record = parseRecord(line);
      if (record.type === "message") messages.push(parseMessage(record, fileName));
      if (record.type === "invocation") invocations.push(parseInvocation(record, fileName));
      if (record.type === "tool-call") {
        const toolCall = tryParseToolCall(record, fileName);
        if (toolCall) toolCallRecords.push(toolCall);
      }
      if (typeof record.timestamp === "string") {
        updatedAt = latestTimestamp(updatedAt, record.timestamp);
      }
    }
    const title =
      titleRecord.type === "title" && typeof titleRecord.title === "string"
        ? titleRecord.title
        : header.title;
    return {
      storageKey,
      header,
      title,
      messages,
      invocations,
      toolCalls: projectToolCalls(toolCallRecords),
      updatedAt,
    };
  }
}
