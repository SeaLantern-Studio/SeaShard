import type {
  AgentActivityPresentation,
  AgentMessageSnapshot,
  AgentModelSelection,
  AgentSessionSnapshot,
  AgentSessionSummary,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import { defaultAgentResourcePresentationTitle } from "@seashard/plugin-sdk";
import type { AgentActivityPresentationField, JsonValue } from "@seashard/plugin-sdk";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const titleSlotBytes = 256;
const sessionVersion = 1;

interface SessionHeaderRecord {
  readonly type: "session";
  readonly version: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly title: string;
  readonly model: AgentModelSelection;
}

interface MessageRecord extends AgentMessageSnapshot {
  readonly type: "message";
}

interface InvocationRecord {
  readonly type: "invocation";
  readonly id: string;
  readonly timestamp: string;
  readonly state: "running" | "completed" | "cancelled" | "failed";
  readonly model: AgentModelSelection;
  readonly text?: string;
  readonly error?: string;
}

interface ToolCallRecord extends AgentToolCallSnapshot {
  readonly type: "tool-call";
  readonly timestamp: string;
}

export interface LoadedAgentSession {
  readonly storageKey: string;
  readonly header: SessionHeaderRecord;
  readonly title: string;
  readonly messages: readonly MessageRecord[];
  readonly invocations: readonly InvocationRecord[];
  readonly toolCalls: readonly AgentToolCallSnapshot[];
  readonly updatedAt: string;
}

/** OMP 风格 JSONL Session Journal；固定宽度标题槽允许重命名时不重写消息历史。 */
export class AgentSessionJournal {
  readonly sessionsRoot: string;

  constructor(private readonly userDataRoot: string) {
    this.sessionsRoot = join(userDataRoot, "agent", "sessions");
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
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
    return {
      ...projectSummary(session),
      messages: session.messages,
      toolCalls: session.toolCalls,
    };
  }

  async appendMessage(input: {
    readonly sessionId: string;
    readonly invocationId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  }): Promise<MessageRecord> {
    const session = await this.get(input.sessionId);
    const record: MessageRecord = {
      type: "message",
      id: uuidV7(),
      invocationId: input.invocationId,
      role: input.role,
      content: input.content,
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
    record: MessageRecord | InvocationRecord | ToolCallRecord,
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
    const messages: MessageRecord[] = [];
    const invocations: InvocationRecord[] = [];
    const toolCallRecords: ToolCallRecord[] = [];
    let updatedAt = header.timestamp;
    for (const line of lines) {
      if (!line) continue;
      const record = parseRecord(line);
      if (record.type === "message") messages.push(parseMessage(record, fileName));
      if (record.type === "invocation") invocations.push(parseInvocation(record, fileName));
      if (record.type === "tool-call") {
        const toolCall = tryParseToolCall(record, fileName);
        if (toolCall) toolCallRecords.push(toolCall);
      }
      if (typeof record.timestamp === "string") updatedAt = record.timestamp;
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

function projectSummary(session: LoadedAgentSession): AgentSessionSummary {
  return {
    id: session.header.id,
    title: session.title,
    createdAt: session.header.timestamp,
    updatedAt: session.updatedAt,
    model: { ...(session.invocations.at(-1)?.model ?? session.header.model) },
  };
}

function encodeTitleSlot(title: string, updatedAt: string): Buffer {
  const record = JSON.stringify({ type: "title", v: 1, title, updatedAt });
  const bytes = Buffer.from(record, "utf8");
  if (bytes.length >= titleSlotBytes) throw new RangeError("Agent 对话标题过长");
  const slot = Buffer.alloc(titleSlotBytes, 0x20);
  bytes.copy(slot);
  slot[titleSlotBytes - 1] = 0x0a;
  return slot;
}

function parseHeader(line: string | undefined, fileName: string): SessionHeaderRecord {
  const record = parseRecord(line ?? "");
  if (
    record.type !== "session" ||
    record.version !== sessionVersion ||
    typeof record.id !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.title !== "string" ||
    !record.model ||
    typeof record.model !== "object" ||
    Array.isArray(record.model)
  ) {
    throw new Error(`Agent Session Header 损坏：${fileName}`);
  }
  const model = record.model as Record<string, unknown>;
  if (typeof model.connectionId !== "string" || typeof model.modelId !== "string") {
    throw new Error(`Agent Session 模型记录损坏：${fileName}`);
  }
  return {
    type: "session",
    version: 1,
    id: record.id,
    timestamp: record.timestamp,
    title: record.title,
    model: { connectionId: model.connectionId, modelId: model.modelId },
  };
}

function parseMessage(record: Record<string, unknown>, fileName: string): MessageRecord {
  if (
    typeof record.id !== "string" ||
    typeof record.invocationId !== "string" ||
    (record.role !== "user" && record.role !== "assistant") ||
    typeof record.content !== "string" ||
    typeof record.timestamp !== "string"
  ) {
    throw new Error(`Agent Session 消息记录损坏：${fileName}`);
  }
  return {
    type: "message",
    id: record.id,
    invocationId: record.invocationId,
    role: record.role,
    content: record.content,
    timestamp: record.timestamp,
  };
}

function parseInvocation(record: Record<string, unknown>, fileName: string): InvocationRecord {
  if (
    typeof record.id !== "string" ||
    typeof record.timestamp !== "string" ||
    !isInvocationState(record.state) ||
    !record.model ||
    typeof record.model !== "object" ||
    Array.isArray(record.model)
  ) {
    throw new Error(`Agent Invocation 记录损坏：${fileName}`);
  }
  const model = record.model as Record<string, unknown>;
  if (typeof model.connectionId !== "string" || typeof model.modelId !== "string") {
    throw new Error(`Agent Invocation 模型记录损坏：${fileName}`);
  }
  return {
    type: "invocation",
    id: record.id,
    timestamp: record.timestamp,
    state: record.state,
    model: { connectionId: model.connectionId, modelId: model.modelId },
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

/**
 * Tool Call 是对话的辅助活动投影。单条记录损坏时只舍弃该投影，
 * 不能让会话标题、消息历史和后续消息发送一起失效。
 */
function tryParseToolCall(
  record: Record<string, unknown>,
  fileName: string,
): ToolCallRecord | undefined {
  try {
    return parseToolCall(record, fileName);
  } catch {
    return undefined;
  }
}

function parseToolCall(record: Record<string, unknown>, fileName: string): ToolCallRecord {
  if (
    typeof record.id !== "string" ||
    typeof record.invocationId !== "string" ||
    typeof record.toolName !== "string" ||
    !isToolCallState(record.state) ||
    typeof record.startedAt !== "string" ||
    typeof record.timestamp !== "string" ||
    (record.finishedAt !== undefined && typeof record.finishedAt !== "string") ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new Error(`Agent Tool Call 记录损坏：${fileName}`);
  }
  return {
    type: "tool-call",
    timestamp: record.timestamp,
    id: record.id,
    invocationId: record.invocationId,
    toolName: record.toolName,
    presentation: parseActivityPresentation(
      record.presentation,
      fileName,
      defaultToolCallPresentationTitle(record.toolName),
    ),
    state: record.state,
    input: requireJsonValue(record.input, fileName, "input"),
    ...(record.output === undefined
      ? {}
      : { output: requireJsonValue(record.output, fileName, "output") }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    startedAt: record.startedAt,
    ...(typeof record.finishedAt === "string" ? { finishedAt: record.finishedAt } : {}),
  };
}

function parseActivityPresentation(
  value: unknown,
  fileName: string,
  fallbackTitle: string,
): AgentActivityPresentation {
  if (value === undefined) return { title: fallbackTitle };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Tool Call presentation 记录损坏：${fileName}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title) {
    throw new Error(`Agent Tool Call presentation 标题损坏：${fileName}`);
  }
  return {
    title: record.title,
    ...(record.requestPayload === undefined
      ? {}
      : {
          requestPayload: parseActivityPresentationFields(
            record.requestPayload,
            fileName,
            "requestPayload",
          ),
        }),
    ...(record.resultPayload === undefined
      ? {}
      : {
          resultPayload: parseActivityPresentationFields(
            record.resultPayload,
            fileName,
            "resultPayload",
          ),
        }),
  };
}

function parseActivityPresentationFields(
  value: unknown,
  fileName: string,
  label: string,
): readonly AgentActivityPresentationField[] {
  if (!Array.isArray(value)) {
    throw new Error(`Agent Tool Call ${label} 记录损坏：${fileName}`);
  }
  return value.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new Error(`Agent Tool Call ${label}[${index}] 记录损坏：${fileName}`);
    }
    const record = field as Record<string, unknown>;
    if (
      typeof record.value !== "string" ||
      (record.label !== undefined && typeof record.label !== "string") ||
      (record.unit !== undefined && typeof record.unit !== "string")
    ) {
      throw new Error(`Agent Tool Call ${label}[${index}] 记录损坏：${fileName}`);
    }
    return {
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      value: record.value,
      ...(typeof record.unit === "string" ? { unit: record.unit } : {}),
    };
  });
}
function defaultToolCallPresentationTitle(toolName: string): string {
  return toolName === "read" ? defaultAgentResourcePresentationTitle : toolName;
}

function projectToolCalls(records: readonly ToolCallRecord[]): readonly AgentToolCallSnapshot[] {
  const calls = new Map<string, AgentToolCallSnapshot>();
  for (const { type: _type, timestamp: _timestamp, ...record } of records) {
    calls.set(record.id, record);
  }
  return [...calls.values()];
}

function requireJsonValue(value: unknown, fileName: string, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => requireJsonValue(entry, fileName, field));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        requireJsonValue(entry, fileName, `${field}.${key}`),
      ]),
    );
  }
  throw new Error(`Agent Tool Call ${field} 不是 JSON 值：${fileName}`);
}

function parseRecord(line: string): Record<string, unknown> {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Agent Session JSONL 记录必须是对象");
  }
  return value as Record<string, unknown>;
}

function isInvocationState(value: unknown): value is InvocationRecord["state"] {
  return (
    value === "running" || value === "completed" || value === "cancelled" || value === "failed"
  );
}

function isToolCallState(value: unknown): value is AgentToolCallSnapshot["state"] {
  return (
    value === "running" || value === "completed" || value === "cancelled" || value === "failed"
  );
}

/** 48 位毫秒时间戳 + RFC 9562 version/variant 位，保证 Session ID 可按时间排序。 */
function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
