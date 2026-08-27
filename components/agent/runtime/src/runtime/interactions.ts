import type {
  AgentPermissionMode,
  AgentTodoItem,
  AgentTodoSnapshot,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import type { TSchema, Tool } from "@earendil-works/pi-ai";
import type { AgentToolConfirmationLevel, JsonValue } from "@seashard/plugin-sdk";

export const askToolName = "ask";
export const todoToolName = "todo";

export const todoPiTool: Tool = {
  name: todoToolName,
  description:
    "管理当前任务的 TODO 清单。仅在需要多个明确步骤时使用；每次调用必须提交完整清单以原子替换旧状态。最多一个条目可以是 in_progress，完成步骤后立即更新清单。",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "简洁、可观察的任务内容",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
        description: "按执行顺序排列的完整任务清单",
      },
    },
    required: ["items"],
    additionalProperties: false,
  } as unknown as TSchema,
};

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

export function parseTodoToolInput(value: JsonValue): readonly AgentTodoItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("todo 输入必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "items");
  if (unexpected.length) throw new TypeError(`todo 包含未知参数：${unexpected.join(", ")}`);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 32) {
    throw new RangeError("todo.items 必须包含 1 到 32 个任务");
  }
  let inProgressCount = 0;
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`todo.items[${index}] 必须是对象`);
    }
    const itemUnexpected = Object.keys(item).filter((key) => key !== "content" && key !== "status");
    if (itemUnexpected.length) {
      throw new TypeError(`todo.items[${index}] 包含未知参数：${itemUnexpected.join(", ")}`);
    }
    if (typeof item.content !== "string") {
      throw new TypeError(`todo.items[${index}].content 必须是字符串`);
    }
    const content = item.content.trim();
    if (!content || content.length > 500) {
      throw new RangeError(`todo.items[${index}].content 长度必须是 1 到 500 个字符`);
    }
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
      throw new TypeError(`todo.items[${index}].status 不合法`);
    }
    if (item.status === "in_progress") inProgressCount += 1;
    return { content, status: item.status } satisfies AgentTodoItem;
  });
  if (inProgressCount > 1) throw new TypeError("todo 同时只能有一个 in_progress 任务");
  if (new Set(items.map(({ content }) => content)).size !== items.length) {
    throw new TypeError("todo.items 不能包含重复任务");
  }
  return items;
}

/** 从追加式工具记录恢复最近一次成功清单；损坏记录会被跳过，避免阻断对话加载。 */
export function projectLatestAgentTodo(
  toolCalls: readonly AgentToolCallSnapshot[],
): AgentTodoSnapshot | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index]!;
    if (call.toolName !== todoToolName || call.state !== "completed") continue;
    try {
      return {
        items: parseTodoToolInput(call.input),
        updatedAt: call.finishedAt ?? call.startedAt,
      };
    } catch {
      continue;
    }
  }
  return undefined;
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
