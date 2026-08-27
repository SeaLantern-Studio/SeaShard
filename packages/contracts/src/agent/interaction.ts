import type { AgentToolConfirmationLevel, JsonValue } from "@seashard/plugin-sdk";

export const agentPermissionModes = ["read-only", "edit", "yolo"] as const;
export type AgentPermissionMode = (typeof agentPermissionModes)[number];

interface AgentInteractionBase {
  readonly id: string;
  readonly invocationId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
}

/** Ask 工具等待 Renderer 回答时投影的单选问题；自定义输入由客户端固定追加。 */
export interface AgentAskInteraction extends AgentInteractionBase {
  readonly type: "ask";
  readonly question: string;
  readonly options: readonly string[];
}

/** 高权限工具在真正进入领域 Handler 前等待用户确认。 */
export interface AgentToolConfirmationInteraction extends AgentInteractionBase {
  readonly type: "tool-confirmation";
  readonly toolName: string;
  readonly title: string;
  readonly confirmationLevel: Exclude<AgentToolConfirmationLevel, 0>;
  readonly input: JsonValue;
}

export type AgentPendingInteraction = AgentAskInteraction | AgentToolConfirmationInteraction;

export type AgentInteractionResponse =
  | {
      readonly interactionId: string;
      readonly type: "ask-option";
      readonly optionIndex: number;
    }
  | {
      readonly interactionId: string;
      readonly type: "ask-custom";
      readonly value: string;
    }
  | {
      readonly interactionId: string;
      readonly type: "tool-confirmation";
      readonly approved: boolean;
    };

export interface AgentInteractionResponseInput {
  readonly invocationId: string;
  readonly response: AgentInteractionResponse;
}
