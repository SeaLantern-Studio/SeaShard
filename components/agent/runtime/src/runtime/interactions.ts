import type { AgentPermissionMode } from "@seashard/contracts";
import type { TSchema, Tool } from "@earendil-works/pi-ai";
import type { AgentToolConfirmationLevel, JsonValue } from "@seashard/plugin-sdk";

export const askToolName = "ask";

export const askPiTool: Tool = {
  name: askToolName,
  description:
    "需要用户做决定或缺少关键信息时，向用户提出一个明确问题并提供 2 到 6 个互斥预选项。客户端会固定追加自定义输入选项。",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
        description: "需要用户回答的单个明确问题",
      },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 300 },
        description: "互斥的预选答案；不要添加“其他”或“自己输入”",
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  } as unknown as TSchema,
};

export interface AgentAskToolInput {
  readonly question: string;
  readonly options: readonly string[];
}

export function parseAskToolInput(value: JsonValue): AgentAskToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ask 输入必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "question" && key !== "options");
  if (unexpected.length) throw new TypeError(`ask 包含未知参数：${unexpected.join(", ")}`);
  if (typeof value.question !== "string") throw new TypeError("ask.question 必须是字符串");
  const question = value.question.trim();
  if (!question || question.length > 2_000) {
    throw new RangeError("ask.question 长度必须是 1 到 2000 个字符");
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6) {
    throw new RangeError("ask.options 必须包含 2 到 6 个选项");
  }
  const options = value.options.map((option, index) => {
    if (typeof option !== "string") throw new TypeError(`ask.options[${index}] 必须是字符串`);
    const normalized = option.trim();
    if (!normalized || normalized.length > 300) {
      throw new RangeError(`ask.options[${index}] 长度必须是 1 到 300 个字符`);
    }
    return normalized;
  });
  if (new Set(options).size !== options.length) throw new TypeError("ask.options 不能包含重复选项");
  return { question, options };
}

export function automaticConfirmationLevel(mode: AgentPermissionMode): AgentToolConfirmationLevel {
  if (mode === "edit") return 1;
  if (mode === "yolo") return 2;
  return 0;
}

export function requiresToolConfirmation(
  mode: AgentPermissionMode,
  level: AgentToolConfirmationLevel | undefined,
): level is Exclude<AgentToolConfirmationLevel, 0> {
  const normalized = level ?? 0;
  return normalized > automaticConfirmationLevel(mode);
}
