import type {
  AgentMessageContentBlock,
  AgentMessageSnapshot,
  AgentModelSelection,
  AgentProviderResponseDetails,
  AgentTokenUsage,
  AgentToolCallSnapshot,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";

export const titleSlotBytes = 256;
export const sessionVersion = 2;

export interface SessionHeaderRecord {
  readonly type: "session";
  readonly version: 2;
  readonly id: string;
  readonly timestamp: string;
  readonly title: string;
  readonly model: AgentModelSelection;
}

export type AgentJournalModelContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
      readonly textSignature?: string;
    }
  | {
      readonly type: "thinking";
      readonly thinking: string;
      readonly thinkingSignature?: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonValue;
      readonly thoughtSignature?: string;
      readonly namespace?: string;
    };
export interface AgentJournalMessageRecord extends AgentMessageSnapshot {
  readonly type: "message";
  /** 仅供下一轮模型回放，snapshot() 会剥离签名与完整工具参数。 */
  readonly providerContent?: readonly AgentJournalModelContentBlock[];
}

export interface InvocationRecord {
  readonly type: "invocation";
  readonly id: string;
  readonly timestamp: string;
  readonly state: "running" | "completed" | "cancelled" | "failed";
  readonly model: AgentModelSelection;
  readonly text?: string;
  readonly contentBlocks?: readonly AgentMessageContentBlock[];
  readonly provider?: AgentProviderResponseDetails;
  readonly usage?: AgentTokenUsage;
  readonly error?: string;
  readonly contextTokens?: number;
}

export interface ToolCallRecord extends AgentToolCallSnapshot {
  readonly type: "tool-call";
  readonly timestamp: string;
}

export interface LoadedAgentSession {
  readonly storageKey: string;
  readonly header: SessionHeaderRecord;
  readonly title: string;
  readonly messages: readonly AgentJournalMessageRecord[];
  readonly invocations: readonly InvocationRecord[];
  readonly toolCalls: readonly AgentToolCallSnapshot[];
  readonly updatedAt: string;
}
