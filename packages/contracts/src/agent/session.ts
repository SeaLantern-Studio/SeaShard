import { defineServiceContract } from "@seashard/plugin-sdk";
import type {
  AgentActivityPresentationField,
  AgentActivityPresentationIcon,
  JsonObject,
  JsonValue,
} from "@seashard/plugin-sdk";
import type { AgentConfiguredModel, AgentModelSelection } from "./model.js";
import type {
  AgentInteractionResponseInput,
  AgentPendingInteraction,
  AgentPermissionMode,
} from "./interaction.js";
import type { AgentTodoSnapshot } from "./todo.js";

/** Agent Session 的创建、读取与续写 Contract。 */
export const agentSessionContract =
  defineServiceContract<AgentSessionService>("seashard.agent-session");
/** Agent Invocation 的运行状态读取与取消 Contract。 */
export const agentInvocationContract = defineServiceContract<AgentInvocationService>(
  "seashard.agent-invocation",
);
export interface AgentUserMessage {
  readonly text: string;
}

export type AgentConversationMode = "chat" | "agent";

export interface AgentInvocationReference {
  readonly sessionId: string;
  readonly invocationId: string;
}

export type AgentInvocationState = "running" | "completed" | "cancelled" | "failed";
export type AgentToolCallState = "running" | "completed" | "cancelled" | "failed";

export interface AgentActivityPresentation {
  readonly title: string;
  readonly icon?: AgentActivityPresentationIcon;
  readonly requestPayload?: readonly AgentActivityPresentationField[];
  readonly resultPayload?: readonly AgentActivityPresentationField[];
}

/** Agent 调用工具时持久化并投影给客户端的稳定活动记录。 */
export interface AgentToolCallSnapshot {
  readonly id: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly presentation: AgentActivityPresentation;
  readonly state: AgentToolCallState;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly startedAt: string;
  /** 工具开始前已经输出的 Assistant 文本长度；使用 JavaScript UTF-16 偏移量。 */
  readonly assistantTextOffset: number;
  readonly finishedAt?: string;
}

export type AgentInvocationContentPart =
  | {
      readonly kind: "text";
      readonly content: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "tool";
      readonly call: AgentToolCallSnapshot;
    };

/**
 * 按工具记录的文本偏移恢复单次 Invocation 的真实输出顺序。
 * 同一偏移上的多个工具保持注册表快照中的原始顺序。
 */
export function interleaveAgentInvocationContent(
  assistantText: string,
  toolCalls: readonly AgentToolCallSnapshot[],
): readonly AgentInvocationContentPart[] {
  const orderedCalls = [...toolCalls].sort(
    (left, right) => left.assistantTextOffset - right.assistantTextOffset,
  );
  const parts: AgentInvocationContentPart[] = [];
  let cursor = 0;
  for (const call of orderedCalls) {
    const offset = Math.max(cursor, Math.min(assistantText.length, call.assistantTextOffset));
    if (offset > cursor) {
      parts.push({
        kind: "text",
        content: assistantText.slice(cursor, offset),
        start: cursor,
        end: offset,
      });
    }
    parts.push({ kind: "tool", call });
    cursor = offset;
  }
  if (cursor < assistantText.length) {
    parts.push({
      kind: "text",
      content: assistantText.slice(cursor),
      start: cursor,
      end: assistantText.length,
    });
  }
  return parts;
}
export type AgentMessageContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
    };

export interface AgentTokenUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/** 供应商返回的原始用量分类；reasoning 已包含在 output 中。 */
export interface AgentTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost?: AgentTokenUsageCost;
}

/** 单个模型 Step 的供应商身份与停止原因；不包含认证信息和加密推理签名。 */
export interface AgentProviderResponseDetails {
  readonly api: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly stopReason: string;
  readonly errorMessage?: string;
  readonly rawStopReason?: string;
  readonly endTurn?: boolean;
  readonly diagnostics?: readonly JsonObject[];
}

export interface AgentMessageSnapshot {
  readonly id: string;
  readonly invocationId: string;
  readonly role: "user" | "assistant";
  /** 纯文本投影，供搜索、标题与第一版调用方继续使用。 */
  readonly content: string;
  readonly contentBlocks: readonly AgentMessageContentBlock[];
  readonly provider?: AgentProviderResponseDetails;
  readonly usage?: AgentTokenUsage;
  readonly timestamp: string;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly model: AgentModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentSessionSnapshot extends AgentSessionSummary {
  readonly messages: readonly AgentMessageSnapshot[];
  readonly toolCalls: readonly AgentToolCallSnapshot[];
  /** Session 最近一次成功 TODO 更新；供响应结束后继续展示任务进度。 */
  readonly todo?: AgentTodoSnapshot;
  /** 最近一次成功取得供应商用量的 Invocation 所占上下文 Token。 */
  readonly contextTokens?: number;
}

export interface AgentInvocationSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly state: AgentInvocationState;
  readonly model: AgentModelSelection;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  /** 当前 Invocation 最后一个模型 Step 完成后的上下文 Token。 */
  readonly contextTokens?: number;
}

export interface AgentInvocationSnapshot extends AgentInvocationSummary {
  readonly text: string;
  readonly contentBlocks: readonly AgentMessageContentBlock[];
  readonly provider?: AgentProviderResponseDetails;
  readonly usage?: AgentTokenUsage;
  readonly toolCalls: readonly AgentToolCallSnapshot[];
  /** 本次 Invocation 已生成的新 Session 标题，供运行中的客户端立即同步侧栏。 */
  readonly sessionTitle?: string;
  /** 等待 Ask 回答或命令确认时，只在运行期公开的交互请求。 */
  readonly interaction?: AgentPendingInteraction;
  /** 当前 Invocation 最近一次由 todo 工具写入的完整任务清单。 */
  readonly todo?: AgentTodoSnapshot;
}

/** 创建、读取和管理可持久化的 Agent 会话。 */
export interface AgentSessionService {
  /**
   * 列出当前配置中可以创建会话的模型。
   *
   * @returns 带连接身份和显示名称的可选模型。
   */
  listModels(): Promise<readonly AgentConfiguredModel[]>;
  /**
   * 创建会话并立即启动第一轮 Invocation。
   *
   * @param input 初始用户消息、会话模式及可选模型。
   * @returns 新会话与首轮 Invocation 的稳定 ID。
   */
  startSession(input: {
    initialMessage: AgentUserMessage;
    mode: AgentConversationMode;
    permissionMode?: AgentPermissionMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference>;
  /**
   * 向已有会话追加用户消息并启动新 Invocation。
   *
   * @param input 会话 ID、用户消息、会话模式及可选模型。
   * @returns 会话与新 Invocation 的稳定 ID。
   */
  sendMessage(input: {
    sessionId: string;
    message: AgentUserMessage;
    mode: AgentConversationMode;
    permissionMode?: AgentPermissionMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference>;
  /**
   * 按更新时间列出当前保存的会话。
   *
   * @returns 不含完整消息正文的会话摘要。
   */
  listSessions(): Promise<readonly AgentSessionSummary[]>;
  /**
   * 读取一个会话的完整消息和工具调用投影。
   *
   * @param sessionId 已保存的会话 ID。
   * @returns 当前会话快照。
   */
  getSession(sessionId: string): Promise<AgentSessionSnapshot>;
  /**
   * 复制已有会话并生成新的会话身份。
   *
   * @param sessionId 源会话 ID。
   * @returns 新会话摘要。
   */
  copySession(sessionId: string): Promise<AgentSessionSummary>;
  /**
   * 更新已有会话标题。
   *
   * @param sessionId 目标会话 ID。
   * @param title 去除首尾空白后的新标题。
   */
  renameSession(sessionId: string, title: string): Promise<void>;
  /**
   * 删除会话及其持久化 Journal。
   *
   * @param sessionId 目标会话 ID。
   */
  deleteSession(sessionId: string): Promise<void>;
}

/** 读取和控制正在执行或已经结算的 Agent Invocation。 */
export interface AgentInvocationService {
  /**
   * 读取 Invocation 的文本、工具活动、待处理交互和最终状态。
   *
   * @param invocationId Invocation ID。
   * @returns 当前 Invocation 快照。
   */
  getInvocation(invocationId: string): Promise<AgentInvocationSnapshot>;
  /**
   * 请求取消仍在运行的模型或工具；已经产生的 Session Journal 记录继续完成持久化。
   *
   * @param invocationId Invocation ID。
   */
  cancelInvocation(invocationId: string): Promise<void>;
  /**
   * 回答当前 Invocation 正在等待的 Ask 或命令确认。
   *
   * @param input Invocation 身份以及与待处理交互严格匹配的响应。
   */
  respondToInteraction(input: AgentInteractionResponseInput): Promise<void>;
}

export interface AgentClientService
  extends
    Pick<
      AgentSessionService,
      | "listModels"
      | "startSession"
      | "sendMessage"
      | "listSessions"
      | "getSession"
      | "copySession"
      | "deleteSession"
    >,
    AgentInvocationService {}
