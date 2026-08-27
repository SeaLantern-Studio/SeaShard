import { interleaveAgentInvocationContent } from "@seashard/contracts";
import type {
  AgentInvocationSnapshot,
  AgentMessageContentBlock,
  AgentProviderResponseDetails,
  AgentTokenUsage,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";
import { randomUUID } from "node:crypto";
import type { AgentJournalModelContentBlock, LoadedAgentSession } from "../session-journal/records";
import { requireJsonValue } from "./validation";

export function projectInvocation(
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
    contentBlocks: structuredClone(last.contentBlocks ?? []),
    toolCalls: session.toolCalls.filter((call) => call.invocationId === invocationId),
    ...(last.state === "running" ? {} : { finishedAt: last.timestamp }),
    ...(last.provider ? { provider: structuredClone(last.provider) } : {}),
    ...(last.usage ? { usage: structuredClone(last.usage) } : {}),
    ...(last.error ? { error: last.error } : {}),
    ...(last.contextTokens === undefined ? {} : { contextTokens: last.contextTokens }),
  };
}

/**
 * 新版记录直接回放 pi-ai 的供应商内容和签名；第一版记录缺少这些字段时，按文本偏移
 * 恢复工具顺序并使用当前模型身份补齐协议消息。
 */
export function projectModelMessages(
  session: LoadedAgentSession,
  currentModel: Model<Api>,
): Message[] {
  const messages: Message[] = [];
  const assistantByInvocation = new Map<string, typeof session.messages>();
  const callsById = new Map(session.toolCalls.map((call) => [call.id, call]));
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    const group = assistantByInvocation.get(message.invocationId) ?? [];
    assistantByInvocation.set(message.invocationId, [...group, message]);
  }

  for (const userMessage of session.messages) {
    if (userMessage.role !== "user") continue;
    messages.push({
      role: "user",
      content: userMessage.content,
      timestamp: parseTimestamp(userMessage.timestamp),
    });
    const assistantMessages = assistantByInvocation.get(userMessage.invocationId) ?? [];
    const hasProviderRecords = assistantMessages.some(
      (message) => message.providerContent && message.provider && message.usage,
    );
    if (hasProviderRecords) {
      for (const message of assistantMessages) {
        const assistant = reviveProviderAssistantMessage(message);
        if (!assistant) continue;
        messages.push(assistant);
        for (const block of assistant.content) {
          if (block.type !== "toolCall") continue;
          messages.push(projectStoredToolResult(block, callsById.get(block.id)));
        }
      }
      continue;
    }
    messages.push(
      ...projectLegacyInvocationMessages(
        assistantMessages.map(({ content }) => content).join(""),
        session.toolCalls.filter(
          (call) => call.invocationId === userMessage.invocationId && call.state !== "running",
        ),
        currentModel,
        parseTimestamp(assistantMessages.at(-1)?.timestamp ?? userMessage.timestamp),
      ),
    );
  }
  return messages;
}

function reviveProviderAssistantMessage(
  record: LoadedAgentSession["messages"][number],
): AssistantMessage | undefined {
  if (!record.providerContent || !record.provider || !record.usage) return undefined;
  return {
    role: "assistant",
    content: record.providerContent.map((block) => {
      if (block.type === "text") {
        return {
          type: "text",
          text: block.text,
          ...(block.textSignature ? { textSignature: block.textSignature } : {}),
        };
      }
      if (block.type === "thinking") {
        return {
          type: "thinking",
          thinking: block.thinking,
          ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
          ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        };
      }
      const argumentsValue = block.arguments;
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments:
          argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
            ? argumentsValue
            : { input: argumentsValue },
        ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
        ...(block.namespace ? { namespace: block.namespace } : {}),
      };
    }),
    api: record.provider.api,
    provider: record.provider.provider,
    model: record.provider.requestedModel,
    ...(record.provider.responseModel ? { responseModel: record.provider.responseModel } : {}),
    ...(record.provider.responseId ? { responseId: record.provider.responseId } : {}),
    usage: revivePiUsage(record.usage),
    stopReason: record.provider.stopReason as AssistantMessage["stopReason"],
    ...(record.provider.errorMessage ? { errorMessage: record.provider.errorMessage } : {}),
    ...(record.provider.rawStopReason ? { rawStopReason: record.provider.rawStopReason } : {}),
    ...(record.provider.endTurn === undefined ? {} : { endTurn: record.provider.endTurn }),
    timestamp: parseTimestamp(record.timestamp),
  };
}

function projectLegacyInvocationMessages(
  text: string,
  calls: readonly AgentToolCallSnapshot[],
  model: Model<Api>,
  timestamp: number,
): Message[] {
  const content: AssistantMessage["content"] = [];
  const orderedCalls: AgentToolCallSnapshot[] = [];
  for (const part of interleaveAgentInvocationContent(text, calls)) {
    if (part.kind === "text") {
      content.push({ type: "text", text: part.content });
      continue;
    }
    orderedCalls.push(part.call);
    content.push({
      type: "toolCall",
      id: part.call.id,
      name: part.call.toolName,
      arguments: asToolArguments(part.call.input),
    });
  }
  if (content.length === 0) return [];
  const assistant: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroPiUsage(),
    stopReason: orderedCalls.length > 0 ? "toolUse" : "stop",
    timestamp,
  };
  return [assistant, ...orderedCalls.map((call) => projectStoredToolResult(undefined, call))];
}

function projectStoredToolResult(
  block: ToolCall | undefined,
  call: AgentToolCallSnapshot | undefined,
): ToolResultMessage<JsonValue> {
  const toolCall = block ?? {
    type: "toolCall",
    id: call?.id ?? randomUUID(),
    name: call?.toolName ?? "unknown",
    arguments: {},
  };
  if (!call) return createPiToolResult(toolCall, "工具调用记录缺失", true);
  return call.state === "completed"
    ? createPiToolResult(toolCall, call.output ?? null, false)
    : createPiToolResult(toolCall, call.error ?? "工具调用未完成", true);
}

export function createPiToolResult(
  call: Pick<ToolCall, "id" | "name">,
  value: JsonValue,
  isError: boolean,
): ToolResultMessage<JsonValue> {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: formatToolResultContent(value) }],
    details: structuredClone(value),
    isError,
    timestamp: Date.now(),
  };
}

function formatToolResultContent(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function asToolArguments(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { input: value };
}

export function projectAssistantContent(
  content: AssistantMessage["content"],
): AgentMessageContentBlock[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") {
      return {
        type: "reasoning",
        text: block.thinking,
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    return { type: "tool-call", toolCallId: block.id };
  });
}

export function projectProviderContent(
  content: AssistantMessage["content"],
): AgentJournalModelContentBlock[] {
  return content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature ? { textSignature: block.textSignature } : {}),
      };
    }
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: requireJsonValue(block.arguments, `工具 ${block.name} 输入`),
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
      ...(block.namespace ? { namespace: block.namespace } : {}),
    };
  });
}

export function projectProviderDetails(message: AssistantMessage): AgentProviderResponseDetails {
  return {
    api: message.api,
    provider: message.provider,
    requestedModel: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
    ...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
    ...(message.diagnostics?.length
      ? { diagnostics: message.diagnostics.map(normalizeProviderDiagnostic) }
      : {}),
  };
}

function normalizeProviderDiagnostic(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (!serialized) return { type: "unknown" };
  const parsed = JSON.parse(serialized) as unknown;
  const normalized = requireJsonValue(parsed, "供应商诊断");
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : { value: normalized };
}

export function projectTokenUsage(usage: Usage): AgentTokenUsage {
  const hasKnownCost = Object.values(usage.cost).every(
    (value) => Number.isFinite(value) && value >= 0,
  );
  return {
    input: normalizeUsageMetric(usage.input),
    output: normalizeUsageMetric(usage.output),
    cacheRead: normalizeUsageMetric(usage.cacheRead),
    cacheWrite: normalizeUsageMetric(usage.cacheWrite),
    ...(usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: normalizeUsageMetric(usage.cacheWrite1h) }),
    ...(usage.reasoning === undefined ? {} : { reasoning: normalizeUsageMetric(usage.reasoning) }),
    totalTokens: normalizeUsageMetric(usage.totalTokens),
    // 负价格是 pi-ai 的“未知”哨兵。省略费用比展示成免费调用更准确。
    ...(hasKnownCost ? { cost: { ...usage.cost } } : {}),
  };
}

/** 上游异常计数不允许污染可持久化的公共 Journal。 */
function normalizeUsageMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function revivePiUsage(usage: AgentTokenUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: usage.cost
      ? { ...usage.cost }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addTokenUsage(
  current: AgentTokenUsage | undefined,
  next: AgentTokenUsage,
): AgentTokenUsage {
  if (!current) return structuredClone(next);
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    ...((current.cacheWrite1h ?? next.cacheWrite1h) === undefined
      ? {}
      : { cacheWrite1h: (current.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    ...((current.reasoning ?? next.reasoning) === undefined
      ? {}
      : { reasoning: (current.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: current.totalTokens + next.totalTokens,
    ...(current.cost && next.cost
      ? {
          cost: {
            input: current.cost.input + next.cost.input,
            output: current.cost.output + next.cost.output,
            cacheRead: current.cost.cacheRead + next.cost.cacheRead,
            cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
            total: current.cost.total + next.cost.total,
          },
        }
      : {}),
  };
}

function zeroPiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function assistantText(content: readonly AgentMessageContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}
