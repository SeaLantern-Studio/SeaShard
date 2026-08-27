import type {
  AgentConversationMode,
  AgentInteractionResponseInput,
  AgentInvocationSnapshot,
  AgentPermissionMode,
  AgentUserMessage,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";

const maximumUserMessageLength = 100_000;
const maximumCustomAnswerLength = 4_000;

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

export function validatePermissionMode(
  value: AgentPermissionMode | undefined,
): AgentPermissionMode {
  if (value === undefined) return "read-only";
  if (value !== "read-only" && value !== "edit" && value !== "yolo") {
    throw new TypeError("Agent 权限模式不合法");
  }
  return value;
}

export function validateInteractionResponseInput(
  input: AgentInteractionResponseInput,
): AgentInteractionResponseInput {
  if (!input || typeof input !== "object") throw new TypeError("Agent 交互响应必须是对象");
  const invocationId = validateIdentifier(input.invocationId, "invocationId");
  const response = input.response;
  if (!response || typeof response !== "object")
    throw new TypeError("Agent 交互响应内容必须是对象");
  const interactionId = validateIdentifier(response.interactionId, "interactionId");
  if (response.type === "ask-option") {
    if (!Number.isSafeInteger(response.optionIndex) || response.optionIndex < 0) {
      throw new TypeError("Agent Ask 选项索引不合法");
    }
    return {
      invocationId,
      response: { interactionId, type: "ask-option", optionIndex: response.optionIndex },
    };
  }
  if (response.type === "ask-custom") {
    if (typeof response.value !== "string") throw new TypeError("Agent Ask 自定义回答必须是字符串");
    const value = response.value.trim();
    if (!value || value.length > maximumCustomAnswerLength) {
      throw new RangeError(
        `Agent Ask 自定义回答长度必须是 1 到 ${maximumCustomAnswerLength} 个字符`,
      );
    }
    return { invocationId, response: { interactionId, type: "ask-custom", value } };
  }
  if (response.type === "tool-confirmation") {
    if (typeof response.approved !== "boolean") {
      throw new TypeError("Agent 工具确认结果必须是布尔值");
    }
    return {
      invocationId,
      response: { interactionId, type: "tool-confirmation", approved: response.approved },
    };
  }
  throw new TypeError("Agent 交互响应类型不合法");
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
    ...(snapshot.interaction ? { interaction: structuredClone(snapshot.interaction) } : {}),
    ...(snapshot.todo ? { todo: structuredClone(snapshot.todo) } : {}),
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
