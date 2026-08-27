import type {
  AgentConversationMode,
  AgentInvocationSnapshot,
  AgentUserMessage,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";

const maximumUserMessageLength = 100_000;

export function createAbortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

export function validateUserMessage(message: AgentUserMessage): string {
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

export function validateConversationMode(value: AgentConversationMode): AgentConversationMode {
  if (value !== "chat" && value !== "agent") throw new TypeError("Agent mode 不合法");
  return value;
}

export function validateIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是字符串`);
  return value;
}

export function requireJsonValue(value: unknown, label: string): JsonValue {
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

export function cloneInvocation(snapshot: AgentInvocationSnapshot): AgentInvocationSnapshot {
  return {
    ...snapshot,
    model: { ...snapshot.model },
    contentBlocks: structuredClone(snapshot.contentBlocks),
    ...(snapshot.provider ? { provider: structuredClone(snapshot.provider) } : {}),
    ...(snapshot.usage ? { usage: structuredClone(snapshot.usage) } : {}),
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

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
