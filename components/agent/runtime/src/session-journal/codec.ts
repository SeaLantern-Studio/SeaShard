import type {
  AgentActivityPresentation,
  AgentMessageContentBlock,
  AgentMessageSnapshot,
  AgentProviderResponseDetails,
  AgentSessionSummary,
  AgentTokenUsage,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import {
  defaultAgentResourcePresentationTitle,
  isAgentActivityPresentationIcon,
} from "@seashard/plugin-sdk";
import type { AgentActivityPresentationField, JsonValue } from "@seashard/plugin-sdk";
import type {
  AgentJournalMessageRecord,
  AgentJournalModelContentBlock,
  InvocationRecord,
  LoadedAgentSession,
  SessionHeaderRecord,
  ToolCallRecord,
} from "./records";
import { sessionVersion, titleSlotBytes } from "./records";

export function latestTimestamp(current: string, candidate: string | undefined): string {
  return candidate && candidate > current ? candidate : current;
}

export function projectSummary(session: LoadedAgentSession): AgentSessionSummary {
  return {
    id: session.header.id,
    title: session.title,
    createdAt: session.header.timestamp,
    updatedAt: session.updatedAt,
    model: { ...(session.invocations.at(-1)?.model ?? session.header.model) },
  };
}
export function projectMessageRecord(record: AgentJournalMessageRecord): AgentMessageSnapshot {
  const { type: _type, providerContent: _providerContent, ...snapshot } = record;
  return structuredClone(snapshot);
}

export function findLatestDragonHTDevContextTokens(
  invocations: readonly InvocationRecord[],
): number | undefined {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    const contextTokens = invocations[index]?.contextTokens;
    if (contextTokens !== undefined) return contextTokens;
  }
  return undefined;
}

export function encodeTitleSlot(title: string, updatedAt: string): Buffer {
  const record = JSON.stringify({ type: "title", v: 1, title, updatedAt });
  const bytes = Buffer.from(record, "utf8");
  if (bytes.length >= titleSlotBytes) throw new RangeError("Agent 对话标题过长");
  const slot = Buffer.alloc(titleSlotBytes, 0x20);
  bytes.copy(slot);
  slot[titleSlotBytes - 1] = 0x0a;
  return slot;
}

export function parseHeader(line: string | undefined, fileName: string): SessionHeaderRecord {
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
  if (
    typeof model.connectionId !== "string" ||
    typeof model.modelId !== "string" ||
    (model.reasoningLevel !== undefined && typeof model.reasoningLevel !== "string")
  ) {
    throw new Error(`Agent Session 模型记录损坏：${fileName}`);
  }
  return {
    type: "session",
    version: 2,
    id: record.id,
    timestamp: record.timestamp,
    title: record.title,
    model: {
      connectionId: model.connectionId,
      modelId: model.modelId,
      ...(model.reasoningLevel === undefined ? {} : { reasoningLevel: model.reasoningLevel }),
    },
  };
}

export function parseMessage(
  record: Record<string, unknown>,
  fileName: string,
): AgentJournalMessageRecord {
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
    contentBlocks: parseContentBlocks(record.contentBlocks, fileName),
    ...(record.provider === undefined
      ? {}
      : { provider: parseProviderDetails(record.provider, fileName) }),
    ...(record.usage === undefined ? {} : { usage: parseTokenUsage(record.usage, fileName) }),
    ...(record.providerContent === undefined
      ? {}
      : { providerContent: parseProviderContent(record.providerContent, fileName) }),
    timestamp: record.timestamp,
  };
}

export function parseInvocation(
  record: Record<string, unknown>,
  fileName: string,
): InvocationRecord {
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
  if (
    typeof model.connectionId !== "string" ||
    typeof model.modelId !== "string" ||
    (model.reasoningLevel !== undefined && typeof model.reasoningLevel !== "string")
  ) {
    throw new Error(`Agent Invocation 模型记录损坏：${fileName}`);
  }
  if (
    record.contextTokens !== undefined &&
    (typeof record.contextTokens !== "number" ||
      !Number.isSafeInteger(record.contextTokens) ||
      record.contextTokens < 0)
  ) {
    throw new Error(`Agent Invocation Token 记录损坏：${fileName}`);
  }
  return {
    type: "invocation",
    id: record.id,
    timestamp: record.timestamp,
    state: record.state,
    model: {
      connectionId: model.connectionId,
      modelId: model.modelId,
      ...(model.reasoningLevel === undefined ? {} : { reasoningLevel: model.reasoningLevel }),
    },
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(record.contentBlocks === undefined
      ? {}
      : { contentBlocks: parseContentBlocks(record.contentBlocks, fileName) }),
    ...(record.provider === undefined
      ? {}
      : { provider: parseProviderDetails(record.provider, fileName) }),
    ...(record.usage === undefined ? {} : { usage: parseTokenUsage(record.usage, fileName) }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.contextTokens === undefined ? {} : { contextTokens: record.contextTokens }),
  };
}

function parseContentBlocks(value: unknown, fileName: string): readonly AgentMessageContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error(`Agent Session contentBlocks 记录损坏：${fileName}`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Agent Session contentBlocks[${index}] 记录损坏：${fileName}`);
    }
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "reasoning" &&
      typeof block.text === "string" &&
      (block.redacted === undefined || typeof block.redacted === "boolean")
    ) {
      return {
        type: "reasoning",
        text: block.text,
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    if (block.type === "tool-call" && typeof block.toolCallId === "string") {
      return { type: "tool-call", toolCallId: block.toolCallId };
    }
    throw new Error(`Agent Session contentBlocks[${index}] 记录损坏：${fileName}`);
  });
}

function parseProviderContent(
  value: unknown,
  fileName: string,
): readonly AgentJournalModelContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error(`Agent Session providerContent 记录损坏：${fileName}`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Agent Session providerContent[${index}] 记录损坏：${fileName}`);
    }
    const block = entry as Record<string, unknown>;
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      (block.textSignature === undefined || typeof block.textSignature === "string")
    ) {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      };
    }
    if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      (block.thinkingSignature === undefined || typeof block.thinkingSignature === "string") &&
      (block.redacted === undefined || typeof block.redacted === "boolean")
    ) {
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    if (
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      (block.thoughtSignature === undefined || typeof block.thoughtSignature === "string") &&
      (block.namespace === undefined || typeof block.namespace === "string")
    ) {
      const argumentsValue = requireJsonValue(
        block.arguments,
        fileName,
        "providerContent.arguments",
      );
      if (
        argumentsValue === null ||
        typeof argumentsValue !== "object" ||
        Array.isArray(argumentsValue)
      ) {
        throw new Error(`Agent Session providerContent[${index}].arguments 记录损坏：${fileName}`);
      }
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: argumentsValue,
        ...(block.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: block.thoughtSignature }),
        ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
      };
    }
    throw new Error(`Agent Session providerContent[${index}] 记录损坏：${fileName}`);
  });
}

function parseProviderDetails(value: unknown, fileName: string): AgentProviderResponseDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Session provider 记录损坏：${fileName}`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.api !== "string" ||
    typeof record.provider !== "string" ||
    typeof record.requestedModel !== "string" ||
    typeof record.stopReason !== "string" ||
    (record.responseModel !== undefined && typeof record.responseModel !== "string") ||
    (record.responseId !== undefined && typeof record.responseId !== "string") ||
    (record.errorMessage !== undefined && typeof record.errorMessage !== "string") ||
    (record.rawStopReason !== undefined && typeof record.rawStopReason !== "string") ||
    (record.endTurn !== undefined && typeof record.endTurn !== "boolean")
  ) {
    throw new Error(`Agent Session provider 记录损坏：${fileName}`);
  }
  const diagnostics =
    record.diagnostics === undefined
      ? undefined
      : parseProviderDiagnostics(record.diagnostics, fileName);
  return {
    api: record.api,
    provider: record.provider,
    requestedModel: record.requestedModel,
    ...(record.responseModel === undefined ? {} : { responseModel: record.responseModel }),
    ...(record.responseId === undefined ? {} : { responseId: record.responseId }),
    stopReason: record.stopReason,
    ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
    ...(record.rawStopReason === undefined ? {} : { rawStopReason: record.rawStopReason }),
    ...(record.endTurn === undefined ? {} : { endTurn: record.endTurn }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function parseProviderDiagnostics(value: unknown, fileName: string) {
  if (!Array.isArray(value)) {
    throw new Error(`Agent Session diagnostics 记录损坏：${fileName}`);
  }
  return value.map((entry, index) => {
    const normalized = requireJsonValue(entry, fileName, `diagnostics[${index}]`);
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new Error(`Agent Session diagnostics[${index}] 记录损坏：${fileName}`);
    }
    return normalized;
  });
}

function parseTokenUsage(value: unknown, fileName: string): AgentTokenUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Session usage 记录损坏：${fileName}`);
  }
  const record = value as Record<string, unknown>;
  let cost: Record<string, unknown> | undefined;
  if (record.cost !== undefined) {
    if (!record.cost || typeof record.cost !== "object" || Array.isArray(record.cost)) {
      throw new Error(`Agent Session usage.cost 记录损坏：${fileName}`);
    }
    cost = record.cost as Record<string, unknown>;
  }
  return {
    input: requireUsageNumber(record.input, fileName, "input"),
    output: requireUsageNumber(record.output, fileName, "output"),
    cacheRead: requireUsageNumber(record.cacheRead, fileName, "cacheRead"),
    cacheWrite: requireUsageNumber(record.cacheWrite, fileName, "cacheWrite"),
    ...(record.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: requireUsageNumber(record.cacheWrite1h, fileName, "cacheWrite1h") }),
    ...(record.reasoning === undefined
      ? {}
      : { reasoning: requireUsageNumber(record.reasoning, fileName, "reasoning") }),
    totalTokens: requireUsageNumber(record.totalTokens, fileName, "totalTokens"),
    ...(cost
      ? {
          cost: {
            input: requireUsageNumber(cost.input, fileName, "cost.input"),
            output: requireUsageNumber(cost.output, fileName, "cost.output"),
            cacheRead: requireUsageNumber(cost.cacheRead, fileName, "cost.cacheRead"),
            cacheWrite: requireUsageNumber(cost.cacheWrite, fileName, "cost.cacheWrite"),
            total: requireUsageNumber(cost.total, fileName, "cost.total"),
          },
        }
      : {}),
  };
}

function requireUsageNumber(value: unknown, fileName: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Agent Session usage.${field} 记录损坏：${fileName}`);
  }
  return value;
}

/**
 * Tool Call 是对话的辅助活动投影。单条记录损坏时只舍弃该投影，
 * 不能让会话标题、消息历史和后续消息发送一起失效。
 */
export function tryParseToolCall(
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
    typeof record.assistantTextOffset !== "number" ||
    !Number.isSafeInteger(record.assistantTextOffset) ||
    record.assistantTextOffset < 0 ||
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
    assistantTextOffset: record.assistantTextOffset,
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
  if (record.icon !== undefined && !isAgentActivityPresentationIcon(record.icon)) {
    throw new Error(`Agent Tool Call presentation 图标损坏：${fileName}`);
  }
  return {
    title: record.title,
    ...(record.icon === undefined ? {} : { icon: record.icon }),
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

export function projectToolCalls(
  records: readonly ToolCallRecord[],
): readonly AgentToolCallSnapshot[] {
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

export function parseRecord(line: string): Record<string, unknown> {
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
